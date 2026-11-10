// Feed Riffle for the Kindle — clear a feed backlog one card at a time.
//
// Feed Riffle (the Zotero desktop plugin, github.com/ievlevpn/zotero-feed-riffle) deals a feed
// backlog out one card at a time and asks for a verdict on each: discard, keep (file it into a
// collection, with tags and a note) or skip. On the Kindle the verdicts are touch: swipe the card
// left to discard, right to keep, or use the buttons; a row of recent collections files a card
// with one tap. A card whose DOI or arXiv id is already in the library is marked "In library";
// keeping it can replace the old item: its notes are copied to the new one and the old one goes
// to Zotero's trash, with the user's yes. Undo takes back the last verdict, whatever it was.
//
// Read this file top to bottom: it is a walk-through of plugin screens. The pieces:
//
//   1. State        the deck and its history, in zk.storage, changed only through
//                   zk.storage.update (a background refresh can run while the user riffles).
//   2. Background   after a sync, at most hourly: fetch the feeds, parse, mark "in library",
//                   add new cards; a badge "N new" on the Plugins icon; zk.ui.refresh().
//   3. Verdicts     discard, skip, keep, replaceOld, undo: plain async functions on the state.
//   4. Screens      the deck (main), the filing screen, the feeds, the end of a sitting. Each
//                   is `render` (state → building blocks) and `onEvent` (what the user did →
//                   verdicts). The app draws the blocks in its own style and redraws only what
//                   changed; the plugin never draws, animates or picks an e-ink refresh.
//   5. Feeds        RSS 2.0, RSS 1.0 and Atom, parsed with txml (bundled into main.js).
//
// On the Kindle there is no Zotero feed reader, so the plugin reads the feeds itself, from
// settings.json.

import { filter, isElementNode, parse, type TNode } from "txml/txml";

// ───────────────────────────── Settings ─────────────────────────────

// settings.json, next to plugin.json, edited over USB:
//   { "feeds": ["https://rss.arxiv.org/rss/math.PR", "https://…/atom.xml"], "tags": ["riffled"] }
declare global {
  namespace zk {
    interface Settings {
      /** RSS or Atom feed addresses. */
      feeds?: string[];
      /** Tags every kept item gets, besides the ones chosen when keeping it. */
      tags?: string[];
    }
  }
}

// ───────────────────────────── 1. State ─────────────────────────────

/** A feed entry, as dealt. Plain JSON, so the deck can live in zk.storage. */
interface Card {
  /** `arxiv:<id with version>`, `doi:<doi>`, or the entry's own id: one card per paper version. */
  id: string;
  /** The feed's address. */
  feed: string;
  title: string;
  authors: string[];
  date: string | null;
  link: string | null;
  summary: string;
  doi: string | null;
  /** With its version suffix, as the feed gives it (`2401.01234v2`). */
  arxiv: string | null;
  /** Keys of library items with the same DOI or arXiv id (any version): the replace candidates. */
  inLibrary: string[];
}

/** One step of the undo history. A keep remembers the changes it asked of Zotero. */
type Step =
  | { kind: "discard" | "skip"; card: Card }
  | { kind: "keep"; card: Card; itemKey: string; changes: { kind: "createItem" | "trash"; key: string; changeId: string }[] };

interface State {
  /** Every card not decided yet, all feeds, in dealing order. */
  deck: Card[];
  /** Ids of cards decided (discarded or kept), so a refresh doesn't deal them again. */
  seen: string[];
  undo: Step[];
  /** Collection keys, most recently used first: the "File into" chips. */
  recent: string[];
  /** Feed address → the title the feed gives itself. */
  titles: Record<string, string>;
  /** The feed being riffled; `null`: all of them. */
  current: string | null;
  /** Cards added by the background since the deck was last opened: the badge. */
  fresh: number;
}

const LIMITS = { seen: 5000, undo: 50, recent: 6 };

const empty = (): State => ({ deck: [], seen: [], undo: [], recent: [], titles: {}, current: null, fresh: 0 });

async function load(): Promise<State> {
  return { ...empty(), ...(await zk.storage.get<State>("state")) };
}

/**
 * Lets `change` modify the stored state and returns what `change` returned. Calls interleave at
 * each `await` (a background refresh can run while the user is deciding), so this goes through
 * zk.storage.update, which runs one update at a time and never loses a change. Slow work — the
 * network, the user's confirmation — is done outside it, so it doesn't hold up the next update.
 */
async function withState<T>(change: (state: State) => T | Promise<T>): Promise<T> {
  let result!: T;
  await zk.storage.update<State>("state", async (old) => {
    const state = { ...empty(), ...old };
    result = await change(state);
    state.seen = state.seen.slice(-LIMITS.seen);
    state.undo = state.undo.slice(-LIMITS.undo);
    return state;
  });
  return result;
}

/** The cards of the feed being riffled, in order. */
function cardsIn(s: State): Card[] {
  return s.current ? s.deck.filter((c) => c.feed === s.current) : s.deck;
}

/** Takes card `id` (default: the top card of the feed being riffled) out of the deck. */
function takeCard(s: State, id?: string): Card | undefined {
  const at = id ? s.deck.findIndex((c) => c.id === id) : s.deck.findIndex((c) => !s.current || c.feed === s.current);
  return at < 0 ? undefined : s.deck.splice(at, 1)[0];
}

function feedName(s: State, feed: string | null): string {
  if (!feed) return "All feeds";
  return s.titles[feed] ?? (URL.canParse(feed) ? new URL(feed).hostname : feed);
}

// ───────────────────────────── 2. Background: fetch, parse, dedupe ─────────────────────────────

// After a sync, at most hourly, with 30 seconds in all: fetch each feed (8 s at most each, so
// one slow host can't eat the run), parse it, drop what is already dealt or decided, mark what
// is already in the library, and add the rest to the deck. The badge counts what is new since
// the deck was last opened; zk.ui.refresh() redraws the deck if the user is riffling right now.
zk.background(async () => {
  const added = await refreshFeeds();
  if (added > 0) {
    const fresh = await withState((s) => (s.fresh += added));
    zk.setBadge(`${fresh} new`);
  }
  zk.ui.refresh();
});

/** Fetches every feed and adds its new cards to the deck. Resolves how many were added. */
async function refreshFeeds(): Promise<number> {
  const before = await load(); // a snapshot is enough here: the merge below checks again
  const known = new Set([...before.seen, ...before.deck.map((c) => c.id)]);
  const fresh: Card[] = [];
  const titles: Record<string, string> = {};
  for (const url of zk.settings.feeds ?? []) {
    try {
      const res = await zk.fetch(url, { timeout: 8000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feed = parseFeed(await res.text(), url);
      if (feed.title) titles[url] = feed.title;
      for (const card of feed.cards) {
        if (known.has(card.id)) continue;
        known.add(card.id);
        card.inLibrary = await inLibrary(card);
        fresh.push(card);
      }
    } catch (e) {
      // One bad feed shouldn't stop the others. (A LimitError "time" — the whole run's 30 s —
      // can't be caught: it ends the run, and the next run starts over.)
      console.warn("skipped feed", url, String(e));
    }
  }
  const added = await withState((s) => {
    const dealt = new Set([...s.seen, ...s.deck.map((c) => c.id)]); // the user may have decided meanwhile
    const add = fresh.filter((c) => !dealt.has(c.id));
    s.deck.push(...add);
    Object.assign(s.titles, titles);
    return add.length;
  });
  console.log(`${added} new cards`);
  return added;
}

/**
 * Library items with the card's DOI or arXiv id. findByIdentifier ignores the arXiv version
 * suffix, so a `v2` announcement finds the `v1` saved months ago.
 */
async function inLibrary(card: Card): Promise<string[]> {
  if (!card.doi && !card.arxiv) return [];
  const items = await zk.library.findByIdentifier({ doi: card.doi ?? undefined, arxiv: card.arxiv ?? undefined });
  return items.map((i) => i.key);
}

// ───────────────────────────── 3. Verdicts ─────────────────────────────

/**
 * The sitting: what the summary shows. Module state — it starts over when the deck opens (the
 * `open` event) and when the plugin restarts. Only time a card was in front of the user counts:
 * a gap of more than five minutes between verdicts was lunch, not reading.
 */
let sitting = { kept: 0, discarded: 0, skipped: 0, ms: 0, last: 0, dealt: 0 };

function tally(kind: Step["kind"], by = 1): void {
  const key = kind === "keep" ? "kept" : kind === "discard" ? "discarded" : "skipped";
  sitting[key] = Math.max(0, sitting[key] + by);
  const now = Date.now();
  if (by > 0 && sitting.last) sitting.ms += Math.min(now - sitting.last, 5 * 60_000);
  sitting.last = now;
}

/** Discard: the card is decided and won't come back. */
async function discard(): Promise<Card | undefined> {
  const card = await withState((s) => {
    const card = takeCard(s);
    if (card) {
      s.seen.push(card.id);
      s.undo.push({ kind: "discard", card });
    }
    return card;
  });
  if (card) tally("discard");
  return card;
}

/** Skip: to the back of the deck, for another day. */
async function skip(): Promise<Card | undefined> {
  const card = await withState((s) => {
    const card = takeCard(s);
    if (card) {
      s.deck.push(card);
      s.undo.push({ kind: "skip", card });
    }
    return card;
  });
  if (card) tally("skip");
  return card;
}

/**
 * Keep: creates the item in Zotero, filed into `collection`, tagged, with `note` as a child
 * note. `cardId` defaults to the top card. Resolves with the new item's key and the old items the
 * user may want to replace ({@link replaceOld}), or `null` if the card is gone.
 */
async function keep(opts: { cardId?: string; collection?: string | null; tags?: string[]; note?: string } = {}) {
  const kept = await withState(async (s) => {
    const card = takeCard(s, opts.cardId);
    if (!card) return null;

    // One call makes the item, files it and tags it: one change, which `cancel` withdraws whole.
    const tags = [...new Set([...(zk.settings.tags ?? []), ...(opts.tags ?? [])])];
    const created = await zk.zotero.createItem(fieldsOf(card), {
      collections: opts.collection ? [opts.collection] : [],
      tags,
    });
    // The note is a second change, on the new item: withdrawing the item withdraws it too.
    if (opts.note?.trim()) await zk.zotero.addNote(created.key, `<p>${escapeHtml(opts.note.trim())}</p>`);

    s.seen.push(card.id);
    s.undo.push({ kind: "keep", card, itemKey: created.key, changes: [{ kind: "createItem", ...created }] });
    if (opts.collection) {
      s.recent = [opts.collection, ...s.recent.filter((k) => k !== opts.collection)].slice(0, LIMITS.recent);
    }
    return { itemKey: created.key, replaces: card.inLibrary };
  });
  if (kept) tally("keep");
  return kept;
}

/**
 * Replaces an old item by the one just kept: copies the old item's notes onto the new item, then
 * asks the user to move the old item to Zotero's trash. The app shows its own confirmation; the
 * plugin waits for the answer: the change if they said yes, `null` if not. If they say no, the
 * copies are withdrawn (they were never sent) and both items stay as they were. Its annotations
 * stay with the old item: they are pinned to its PDF. Resolves whether the old item was trashed.
 */
async function replaceOld(oldKey: string, newKey: string): Promise<boolean> {
  const copies = [];
  for (const note of await zk.library.notes(oldKey)) copies.push(await zk.zotero.addNote(newKey, note.html));

  const trashed = await zk.zotero.trash(oldKey);
  if (!trashed) {
    for (const copy of copies) await zk.zotero.cancel(copy.changeId);
    return false;
  }
  // Remember the trash with the keep, so undo puts the old item back.
  await withState((s) => {
    const last = s.undo.at(-1);
    if (last?.kind === "keep" && last.itemKey === newKey) last.changes.push({ kind: "trash", ...trashed });
  });
  return true;
}

/**
 * Undo the last discard, skip or keep; the card comes back to the top of the deck. Undoing a
 * keep withdraws its changes if they haven't been synced yet (no confirmation: nothing left the
 * Kindle). Once synced, a new item can only be trashed — the user is asked — and an old item
 * already trashed in Zotero is restored there, by the user. Resolves a line for the screen.
 */
async function undo(): Promise<string> {
  const step = await withState((s) => s.undo.pop());
  if (!step) return "Nothing to undo";

  const left: string[] = [];
  if (step.kind === "keep") {
    for (const change of step.changes.toReversed()) {
      if (await zk.zotero.cancel(change.changeId)) continue; // withdrawn, as if never asked
      if (change.kind === "createItem") {
        if (!(await zk.zotero.trash(change.key))) left.push("the new item stays in your library");
      } else {
        left.push("the old item is in Zotero's trash: restore it there");
      }
    }
  }

  await withState((s) => {
    s.deck = [step.card, ...s.deck.filter((c) => c.id !== step.card.id)];
    s.seen = s.seen.filter((id) => id !== step.card.id);
  });
  tally(step.kind, -1);
  const done = { discard: "Undid the discard", skip: "Undid the skip", keep: "Undid the keep" }[step.kind];
  return [done, ...left].join("; ");
}

// ───────────────────────────── 4. Screens ─────────────────────────────

// A screen is `render` + `onEvent`. render(params) returns building blocks (zk.ui.*) for the
// state as it is now; it may await quick reads (1 second). onEvent(event, params) gets what the
// user did — a swipe, a tap, typing — with the time of an action (30 seconds and more), and may
// change Zotero and ask the user to confirm a removal. After each event the app renders again and
// redraws only what changed. zk.ui.open pushes another screen; zk.ui.close pops it, and the
// screen below gets a `result` event.

// ── The deck (main: listed in the Plugins launcher on Home) ──

/** The last verdict's outcome, shown quietly under the buttons. */
let message: string | null = null;

zk.screen("deck", {
  title: "Feed Riffle",
  main: true,
  render: async () => {
    const s = await load();
    const cards = cardsIn(s);
    const top = cards[0];
    const header = zk.ui.row([
      zk.ui.text(`${feedName(s, s.current)} · ${cards.length} left`, { style: "label" }),
      zk.ui.button({ id: "feeds", title: "Feeds" }),
    ]);
    // No card left: the sitting ends on its summary, with the feeds that still have cards.
    if (!top) {
      return zk.ui.column([
        header,
        ...summary(s),
        zk.ui.buttons([{ id: "undo", title: "Undo" }]),
        message && zk.ui.notice(message),
      ]);
    }
    const recent = await recentCollections(s.recent);
    return zk.ui.column([
      header,
      // Swipe left: discard; right: keep. The app turns the card like a page.
      zk.ui.deck({ id: "card", card: cardBlock(top, !s.current ? feedName(s, top.feed) : null) }),
      // Recent collections: one tap files the card there (the desktop's keys 1–9).
      recent.length > 0 && zk.ui.text("File into", { style: "label" }),
      recent.length > 0 &&
        zk.ui.chips({ id: "recent", select: "none", chips: recent.map((c) => ({ id: c.key, title: c.name })) }),
      zk.ui.buttons([
        { id: "discard", title: "Discard" },
        { id: "skip", title: "Skip" },
        { id: "keep", title: "Keep", primary: true },
      ]),
      zk.ui.buttons([
        { id: "undo", title: "Undo" },
        { id: "done", title: "Done" },
      ]),
      message && zk.ui.notice(message),
    ]);
  },
  onEvent: async (e) => {
    switch (e.kind) {
      case "open": {
        // A new sitting: the tally starts over, and what the badge announced is now seen.
        const s = await withState((s) => {
          s.fresh = 0;
          return s;
        });
        sitting = { kept: 0, discarded: 0, skipped: 0, ms: 0, last: 0, dealt: cardsIn(s).length };
        message = null;
        zk.setBadge(null);
        return;
      }
      case "swipe":
        return e.direction === "left" ? onDiscard() : onKeep();
      case "tap":
        if (e.id === "discard") return onDiscard();
        if (e.id === "keep") return onKeep();
        if (e.id === "skip") {
          const card = await skip();
          message = card ? `Skipped “${short(card.title)}”` : null;
        }
        if (e.id === "undo") message = await undo();
        if (e.id === "feeds") zk.ui.open("feeds");
        if (e.id === "done") zk.ui.open("summary");
        return;
      case "chips": {
        // A recent collection: file straight away, no filing screen.
        const kept = await keep({ collection: e.chip });
        const name = (await zk.library.collections()).find((c) => c.key === e.chip)?.name ?? "the collection";
        message = kept ? `Kept into ${name}` : null;
        return;
      }
      case "select": // a feed in the summary's list (when the deck has run out)
        message = await switchFeed(e.row);
        return;
      case "result": // the filing screen, the feeds or the summary closed; they say what happened
        if (typeof e.value === "string") message = e.value;
        return;
    }
  },
});

async function onDiscard(): Promise<void> {
  const card = await discard();
  message = card ? `Discarded “${short(card.title)}”` : null;
}

/** Keep opens the filing screen for the top card; it closes with a line for the notice. */
async function onKeep(): Promise<void> {
  const top = cardsIn(await load())[0];
  if (top) zk.ui.open("file", { cardId: top.id });
}

function cardBlock(card: Card, feed: string | null): zk.ui.CardBlock {
  const authors = card.authors.length > 3 ? `${card.authors.slice(0, 3).join(", ")} et al.` : card.authors.join(", ");
  return zk.ui.card({
    title: card.title,
    meta: [authors, card.date, feed].filter(Boolean).join(" · "),
    body: card.summary, // plain text; LaTeX stays as source
    badge: card.inLibrary.length ? "In library" : undefined,
  });
}

/** The recent collections, for the "File into" chips. */
async function recentCollections(recent: string[]): Promise<zk.Collection[]> {
  if (!recent.length) return [];
  const all = await zk.library.collections();
  return recent.flatMap((key) => all.filter((c) => c.key === key));
}

// ── The end of a sitting: "Done", or the deck running out ──

/** The sitting in figures, and the feeds that still have cards (a list: tap one to riffle it). */
function summary(s: State): zk.ui.Child[] {
  const { kept, discarded, skipped, ms, dealt } = sitting;
  const decided = kept + discarded;
  const left = cardsIn(s).length;
  const minutes = Math.round(ms / 60_000);
  const perCard = decided + skipped ? Math.round(ms / 1000 / (decided + skipped)) : 0;
  const others = feedCounts(s).filter((f) => f.count > 0 && f.feed !== s.current);
  return [
    zk.ui.text(dealt ? `${decided} of ${dealt} cleared` : "Nothing to riffle", { style: "title" }),
    zk.ui.text(
      dealt
        ? `${skipped} skipped for later, ${left} still to riffle`
        : "Feeds are fetched after a sync, at most hourly — or Feeds → Fetch now.",
      { style: "meta" },
    ),
    decided + skipped > 0 &&
      zk.ui.text(`${kept} kept · ${discarded} discarded · ${skipped} skipped · ${minutes} min · ${perCard} s a card`, { style: "meta" }),
    others.length > 0 && zk.ui.divider(),
    others.length > 0 && zk.ui.text("Still to riffle", { style: "label" }),
    others.length > 0 &&
      zk.ui.list({ id: "next", rows: others.map((f) => ({ id: f.feed, title: feedName(s, f.feed), meta: `${f.count}` })) }),
  ];
}

zk.screen("summary", {
  title: "The sitting",
  render: async () => zk.ui.column(summary(await load())),
  onEvent: async (e) => {
    if (e.kind === "select") zk.ui.close(await switchFeed(e.row));
  },
});

// ── Feeds: switch deck, or fetch now ──

function feedCounts(s: State): { feed: string; count: number }[] {
  const feeds = [...new Set([...(zk.settings.feeds ?? []), ...s.deck.map((c) => c.feed)])];
  return feeds.map((feed) => ({ feed, count: s.deck.filter((c) => c.feed === feed).length }));
}

/** Riffle `feed` (`"*"`: all feeds); resolves a line for the deck's notice. */
async function switchFeed(feed: string): Promise<string> {
  const s = await withState((s) => {
    s.current = feed === "*" ? null : feed;
    return s;
  });
  return `Riffling ${feedName(s, s.current)}`;
}

let fetched: string | null = null;

zk.screen("feeds", {
  title: "Feeds",
  render: async () => {
    const s = await load();
    const rows: zk.ui.ListRow[] = [
      { id: "*", title: "All feeds", meta: `${s.deck.length}`, selected: s.current === null },
      ...feedCounts(s).map(({ feed, count }) => ({
        id: feed,
        title: feedName(s, feed),
        subtitle: feed,
        meta: `${count}`,
        selected: s.current === feed,
      })),
    ];
    return zk.ui.column([
      zk.ui.list({ id: "feeds", rows }),
      zk.ui.button({ id: "fetch", title: "Fetch now" }),
      fetched && zk.ui.notice(fetched),
    ]);
  },
  onEvent: async (e) => {
    if (e.kind === "open") fetched = null;
    if (e.kind === "select") zk.ui.close(await switchFeed(e.row));
    // onEvent has an action's time (30 s and more), enough to fetch every feed while the user
    // waits; the app shows "Working…" after a second.
    if (e.kind === "tap" && e.id === "fetch") {
      const added = await refreshFeeds();
      fetched = added ? `${added} new card${added === 1 ? "" : "s"}` : "Nothing new";
    }
  },
});

// ── Filing: a collection, tags, a note; and the replace question ──

// What the filing screen is building up. Set by its `open` event, changed by its events, read
// by its render. Fields the plugin must change (the tag box, cleared after each tag) pass
// `value`; the others (the collection search, the note) are left to the app, and their text
// arrives in `change` events — always before the tap on File.
interface Draft {
  card: Card;
  collections: zk.Collection[];
  libraryTags: string[];
  /** The old copies: title, notes, and the collections they are in ("already in"). */
  old: { key: string; title: string; notes: number; collections: string[] }[];
  query: string;
  collection: string | null;
  tags: string[];
  tagText: string;
  note: string;
  replace: boolean;
}

let draft: Draft | null = null;

zk.screen<{ cardId: string }>("file", {
  title: "Keep",
  render: () => {
    const d = draft;
    if (!d) return zk.ui.notice("This card is no longer in the deck.");
    const chosen = d.collections.find((c) => c.key === d.collection);
    const notes = d.old.reduce((n, o) => n + o.notes, 0);
    const suggestions = d.tagText
      ? d.libraryTags.filter((t) => !d.tags.includes(t) && t.toLowerCase().includes(d.tagText.toLowerCase())).slice(0, 8)
      : [];
    return zk.ui.column([
      zk.ui.text(d.card.title, { style: "title", lines: 2 }),
      d.old.length > 0 &&
        zk.ui.notice(`Already in your library — filing adds a second item. The old one holds ${notes} note${notes === 1 ? "" : "s"}.`),
      // A one-chip set reads as a switch: on, the old copy goes to the trash (after the app asks).
      d.old.length > 0 &&
        zk.ui.chips({
          id: "replace",
          chips: [{ id: "trash", title: "Move the old one to the trash" }],
          selected: d.replace ? ["trash"] : [],
        }),
      zk.ui.search({ id: "find", placeholder: "Collection", focus: true }),
      zk.ui.list({ id: "collections", rows: collectionRows(d), empty: "No collection matches" }),
      zk.ui.text("Tags", { style: "label" }),
      // Chosen tags are selected chips (tap to drop); matches for what is typed follow, unselected.
      (d.tags.length > 0 || suggestions.length > 0) &&
        zk.ui.chips({ id: "tags", chips: [...d.tags, ...suggestions], selected: d.tags }),
      zk.ui.field({ id: "tag", placeholder: "Add a tag", value: d.tagText }),
      zk.ui.field({ id: "note", label: "Note", lines: 3 }),
      zk.ui.button({ id: "file", title: chosen ? `File into ${chosen.name}` : "Keep (no collection)", primary: true }),
    ]);
  },
  onEvent: async (e, { cardId }) => {
    if (e.kind === "open") {
      draft = await startDraft(cardId);
      return;
    }
    const d = draft;
    if (!d) return;
    switch (e.kind) {
      case "change":
        if (e.id === "find") d.query = e.text;
        if (e.id === "tag") d.tagText = e.text;
        if (e.id === "note") d.note = e.text;
        return;
      case "submit":
        if (e.id === "find") d.collection = matches(d)[0]?.key ?? d.collection;
        if (e.id === "tag" && e.text.trim()) {
          d.tags = [...new Set([...d.tags, e.text.trim()])];
          d.tagText = ""; // differs from what was typed, so the app clears the box
        }
        return;
      case "select":
        d.collection = e.row;
        return;
      case "chips":
        if (e.id === "replace") d.replace = e.selected.includes("trash");
        if (e.id === "tags") {
          d.tags = e.selected;
          d.tagText = "";
        }
        return;
      case "tap":
        if (e.id === "file") zk.ui.close(await fileDraft(d));
        return;
      case "back":
        draft = null; // Back: the card stays on top of the deck, undecided
        return;
    }
  },
});

async function startDraft(cardId: string): Promise<Draft | null> {
  const s = await load();
  const card = s.deck.find((c) => c.id === cardId);
  if (!card) return null;
  const [collections, tags] = await Promise.all([zk.library.collections(), zk.library.tags()]);
  const old = [];
  for (const key of card.inLibrary) {
    const item = await zk.library.item(key);
    if (item) old.push({ key, title: item.title, notes: (await zk.library.notes(key)).length, collections: item.collections });
  }
  return {
    card,
    collections,
    libraryTags: tags.map((t) => t.name),
    old,
    query: "",
    // Pointed at the collection used last, so File alone files it there.
    collection: s.recent[0] ?? null,
    tags: [],
    tagText: "",
    note: "",
    replace: false,
  };
}

/** Collections whose path has every word typed, old copies' collections first, then recent ones. */
function matches(d: Draft): zk.Collection[] {
  const words = d.query.toLowerCase().split(/\s+/).filter(Boolean);
  const hoisted = new Set(d.old.flatMap((o) => o.collections));
  const found = d.collections.filter((c) => words.every((w) => c.path.join(" / ").toLowerCase().includes(w)));
  return found.sort((a, b) => Number(hoisted.has(b.key)) - Number(hoisted.has(a.key)));
}

function collectionRows(d: Draft): zk.ui.ListRow[] {
  const hoisted = new Set(d.old.flatMap((o) => o.collections));
  return matches(d)
    .slice(0, 200)
    .map((c) => ({
      id: c.key,
      title: c.path.join(" / "),
      badge: hoisted.has(c.key) ? "already in" : undefined,
      selected: c.key === d.collection,
    }));
}

/** Keeps the card as drafted; replaces the old copy if asked. Resolves a line for the deck. */
async function fileDraft(d: Draft): Promise<string> {
  draft = null;
  const kept = await keep({ cardId: d.card.id, collection: d.collection, tags: d.tags, note: d.note });
  if (!kept) return "That card is no longer in the deck";
  const where = d.collections.find((c) => c.key === d.collection)?.name;
  let line = where ? `Kept into ${where}` : "Kept";
  if (d.replace && kept.replaces.length) {
    // The app asks the user, in its own confirmation; the screen waits, and the wait doesn't
    // count against onEvent's time.
    let trashed = 0;
    for (const oldKey of kept.replaces) if (await replaceOld(oldKey, kept.itemKey)) trashed++;
    line += trashed ? "; the old one is in the trash (Undo puts it back)" : "; kept the old one too";
  }
  return line;
}

function short(title: string): string {
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

// ───────────────────────────── 5. Feed parsing ─────────────────────────────

// RSS 2.0, RSS 1.0 (RDF) and Atom, with txml — a small, dependency-free XML parser bundled into
// main.js by build.mjs. Feeds are read leniently: whatever field is there is used.

/** A feed's title and its entries, as cards. (Exported for testing; the app ignores exports.) */
export function parseFeed(xml: string, feed: string): { title: string | null; cards: Card[] } {
  // selfClosingTags: [] — txml treats <link> as an HTML void element by default, which would
  // lose RSS's <link>https://…</link>. decodeEntities turns &amp; etc. into characters
  // (CDATA sections are left as they are, as XML says).
  const nodes = parse(xml, { selfClosingTags: [], decodeEntities: true });
  const entries = filter(nodes, (n) => n.tagName === "item" || n.tagName === "entry");
  const channel = filter(nodes, (n) => n.tagName === "channel" || n.tagName === "feed")[0];
  const title = channel ? oneLine(stripTags(text(child(channel, "title")))) : "";
  return { title: title || null, cards: entries.map((entry) => toCard(entry, feed)).filter((c) => c.title) };
}

function toCard(entry: TNode, feed: string): Card {
  const link = atomLink(entry) ?? text(child(entry, "link"));
  const guid = text(child(entry, "guid") ?? child(entry, "id"));
  const hrefs = children(entry, "link").map((l) => l.attributes.href ?? "");
  const ids = [guid, link, text(child(entry, "dc:identifier")), ...hrefs].join(" ");
  const arxiv = ids.match(/arxiv\.org\/abs\/([^\s?#]+)|oai:arXiv\.org:(\S+)|arXiv:(\d{4}\.\d{4,5}(?:v\d+)?)/i)?.slice(1).find(Boolean) ?? null;
  const doi = (text(child(entry, "prism:doi") ?? child(entry, "arxiv:doi")) || ids.match(/\b10\.\d{4,9}\/\S+/)?.[0]) ?? null;
  const date = text(child(entry, "pubDate") ?? child(entry, "published") ?? child(entry, "dc:date") ?? child(entry, "updated"));
  return {
    id: arxiv ? `arxiv:${arxiv}` : doi ? `doi:${doi.toLowerCase()}` : guid || link || text(child(entry, "title")),
    feed,
    title: oneLine(stripTags(text(child(entry, "title")))),
    authors: authorsOf(entry),
    date: date ? isoDate(date) : null,
    link: link || null,
    summary: oneLine(stripTags(text(child(entry, "description") ?? child(entry, "summary") ?? child(entry, "content")))),
    doi: doi || null,
    arxiv,
    inLibrary: [],
  };
}

function child(node: TNode, name: string): TNode | undefined {
  return node.children.find((c): c is TNode => isElementNode(c) && c.tagName === name);
}

function children(node: TNode, name: string): TNode[] {
  return node.children.filter((c): c is TNode => isElementNode(c) && c.tagName === name);
}

/** All the text inside a node. */
function text(node: TNode | string | undefined): string {
  if (node === undefined) return "";
  if (typeof node === "string") return node;
  return node.children.map(text).join("").trim();
}

/** Atom's `<link rel="alternate" href="…"/>`. */
function atomLink(entry: TNode): string | null {
  const links = children(entry, "link").filter((l) => l.attributes.href);
  const page = links.find((l) => (l.attributes.rel ?? "alternate") === "alternate") ?? links[0];
  return page?.attributes.href ?? null;
}

/** Atom `<author><name>`, or `<dc:creator>` (arXiv lists them comma-separated in one), or RSS `<author>`. */
function authorsOf(entry: TNode): string[] {
  const atom = children(entry, "author").map((a) => text(child(a, "name"))).filter(Boolean);
  if (atom.length) return atom;
  const dc = children(entry, "dc:creator").map((c) => text(c));
  if (dc.length === 1) return dc[0]!.split(/,\s*(?:and\s+)?|\s+and\s+/).filter(Boolean);
  if (dc.length) return dc;
  return children(entry, "author").map((a) => text(a)).filter(Boolean);
}

/**
 * Markup out, crudely. (The desktop Feed Riffle renders feed HTML through a sanitizer and is
 * careful not to read `$1<p<\infty$` as a tag; on the Kindle a card shows plain text.)
 */
function stripTags(html: string): string {
  return html.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** `2024-01-03` from any date `Date` can read; the text as given otherwise. */
function isoDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// ───────────────────────────── Card → Zotero item ─────────────────────────────

function fieldsOf(card: Card): zk.ItemFields {
  return {
    type: card.arxiv ? "preprint" : "journalArticle",
    title: card.title,
    creators: card.authors.map(toCreator),
    date: card.date ?? undefined,
    doi: card.doi ?? undefined,
    arxiv: card.arxiv ?? undefined,
    url: card.link ?? undefined,
    abstract: card.summary || undefined,
  };
}

/** "Robert J. Adler" → first "Robert J.", last "Adler"; a one-word name stays whole. */
function toCreator(name: string): zk.Creator {
  const at = name.lastIndexOf(" ");
  return at < 0 ? { type: "author", name } : { type: "author", first: name.slice(0, at), last: name.slice(at + 1) };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
