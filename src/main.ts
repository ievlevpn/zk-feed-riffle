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
//   1. State        the history in one zk.storage key, each feed's cards in a key of its own,
//                   changed only through zk.storage.update (a background refresh can run
//                   while the user riffles).
//   2. Background   after a sync, at most hourly: fetch the feeds, parse, mark "in library",
//                   add new cards; a badge "N new" on the Plugins icon; zk.ui.refresh().
//   3. Verdicts     discard, skip, keep, replaceOld, undo: plain async functions on the state.
//   4. Screens      the deck (main), the filing screen, the feeds, the end of a sitting. Each
//                   is `render` (state → building blocks) and `onEvent` (what the user did →
//                   verdicts). The app draws the blocks in its own style and redraws only what
//                   changed; the plugin never draws, animates or picks an e-ink refresh.
//   5. Feeds        RSS 2.0, RSS 1.0 and Atom, parsed with txml (bundled into main.js).
//
// On the Kindle there is no Zotero feed reader, so the plugin reads the feeds itself: the ones
// you subscribe to in Zotero (synced, zk.library.feeds), or the ones settings.json lists.

import { filter, isElementNode, parse, type TNode } from "txml/txml";

// ───────────────────────────── Settings ─────────────────────────────

// settings.json, next to plugin.json, edited over USB (optional):
//   { "feeds": ["https://rss.arxiv.org/rss/math.PR", "https://…/atom.xml"], "tags": ["riffled"] }
// Without "feeds", the plugin riffles your Zotero feeds.
declare global {
  namespace zk {
    interface Settings {
      /** RSS or Atom feed addresses; without them, your Zotero feeds. */
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

// Storage holds one small key for the state ("state") and one key per feed for its undecided
// cards ("deck:" + a hash of the feed's address). zk.storage takes at most 1 MB a value and 16 MB
// in all, and a backlog of 34 feeds with abstracts is more than 1 MB: one key for everything
// stopped being saved. Each key is updated on its own (an update can't write another key), so
// a verdict writes in an order a crash can't undo: the card's id goes into `seen` first, then
// the card leaves its deck — and load() drops any deck card whose id is in `seen`.

interface State {
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
  /** Feed address → when it was last fetched (ms): the oldest goes first. */
  fetchedAt: Record<string, number>;
  /** The card Undo brought back: dealt first, whichever feed it is in. */
  top: string | null;
}

/** A feed's undecided cards, in dealing order, under `deck:<hash of the feed>`. */
interface Deck {
  feed: string;
  cards: Card[];
}

/** The state and every feed's undecided cards (feed → cards): what the screens show. */
interface View {
  s: State;
  decks: Map<string, Card[]>;
}

const LIMITS = {
  seen: 5000,
  undo: 50,
  recent: 6,
  /** Undecided cards a feed keeps; over that, its oldest are dropped (not marked seen). */
  cards: 150,
  /** A card's title, summary and authors, as stored. */
  title: 500,
  summary: 1500,
  authors: 100,
  /** A feed's deck, in bytes — and all decks together (zk.storage: 1 MB a value, 16 MB in all). */
  deckBytes: 400_000,
  allBytes: 12_000_000,
};

const STATE = "state";
const DECK = "deck:";

const empty = (): State => ({ seen: [], undo: [], recent: [], titles: {}, current: null, fresh: 0, fetchedAt: {}, top: null });

function deckKey(feed: string): string {
  return DECK + hash(feed);
}

/** Reads the state and the decks, decided cards left out. */
async function load(): Promise<View> {
  await migrated();
  // Decks first, then the state: a verdict writes `seen` before the deck, so a card decided
  // between the two reads is either gone from its deck or already in `seen`.
  const decks = await readDecks();
  const s: State = { ...empty(), ...(await zk.storage.get<State>(STATE)) };
  return { s, decks: undecided(decks, s) };
}

async function readDecks(): Promise<Map<string, Card[]>> {
  const decks = new Map<string, Card[]>();
  const keys = (await zk.storage.keys()).filter((k) => k.startsWith(DECK)).sort();
  for (const key of keys) {
    const d = await zk.storage.get<Deck>(key);
    if (d?.feed && d.cards?.length) decks.set(d.feed, d.cards);
  }
  return decks;
}

function undecided(decks: Map<string, Card[]>, s: State): Map<string, Card[]> {
  const seen = new Set(s.seen);
  return new Map([...decks].map(([feed, cards]) => [feed, cards.filter((c) => !seen.has(c.id))]));
}

/**
 * Lets `change` modify the stored state and returns what `change` returned. Calls interleave at
 * each `await` (a background refresh can run while the user is deciding), so this goes through
 * zk.storage.update, which runs one update at a time and never loses a change. Slow work — the
 * network, the user's confirmation — is done outside it, so it doesn't hold up the next update.
 */
async function withState<T>(change: (state: State) => T | Promise<T>): Promise<T> {
  await migrated();
  let result!: T;
  await zk.storage.update<State>(STATE, async (old) => {
    const state = { ...empty(), ...old };
    result = await change(state);
    state.seen = state.seen.slice(-LIMITS.seen);
    state.undo = state.undo.slice(-LIMITS.undo);
    return state;
  });
  return result;
}

/** Changes `feed`'s deck, as one step; an empty deck is deleted. */
async function withDeck(feed: string, change: (cards: Card[]) => Card[] | Promise<Card[]>): Promise<void> {
  await zk.storage.update<Deck>(deckKey(feed), async (old) => {
    const cards = await change(old?.feed === feed ? old.cards : []);
    return cards.length ? { feed, cards } : undefined;
  });
}

/** Inside a state update: the view, with that state. (Reading other keys there is allowed.) */
async function viewOf(s: State): Promise<View> {
  return { s, decks: undecided(await readDecks(), s) };
}

/** The feeds in dealing order: as feedList() gives them, then any other that still has cards. */
function feedOrder(v: View): string[] {
  return [...new Set([...followed, ...v.decks.keys()])];
}

/** The cards of the feed being riffled (all feeds, one after another), in order. */
function cardsIn(v: View): Card[] {
  const cards = v.s.current ? (v.decks.get(v.s.current) ?? []) : feedOrder(v).flatMap((f) => v.decks.get(f) ?? []);
  const at = v.s.top ? cards.findIndex((c) => c.id === v.s.top) : -1;
  return at > 0 ? [cards[at]!, ...cards.slice(0, at), ...cards.slice(at + 1)] : cards;
}

/** Card `id` (default: the top card of the feed being riffled), if it is undecided. */
function findCard(v: View, id?: string): Card | undefined {
  if (!id) return cardsIn(v)[0];
  for (const cards of v.decks.values()) {
    const card = cards.find((c) => c.id === id);
    if (card) return card;
  }
  return undefined;
}

/**
 * Bounds a deck: at most LIMITS.cards cards and `bytes` bytes of JSON. The oldest go (by date,
 * then by place in the deck); they are just gone, not marked seen.
 */
function bound(cards: Card[], bytes: number): Card[] {
  let size = utf8Length(JSON.stringify(cards));
  let n = cards.length;
  if (n <= LIMITS.cards && size <= bytes) return cards;
  const oldest = cards.map((c, i) => ({ c, i })).sort((a, b) => (a.c.date ?? "").localeCompare(b.c.date ?? "") || a.i - b.i);
  const drop = new Set<Card>();
  for (const { c } of oldest) {
    if (n <= LIMITS.cards && size <= bytes) break;
    drop.add(c);
    n--;
    size -= utf8Length(JSON.stringify(c)) + 1;
  }
  return cards.filter((c) => !drop.has(c));
}

/** A card as stored: long titles, abstracts and author lists cut. */
function capCard(card: Card): Card {
  return {
    ...card,
    title: cut(card.title, LIMITS.title),
    summary: cut(card.summary, LIMITS.summary),
    authors: card.authors.slice(0, LIMITS.authors).map((a) => cut(a, 100)),
  };
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) (n += 4), i++;
    else n += 3;
  }
  return n;
}

/** A short stable hash of a string (cyrb53, base 36): a feed's storage key. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Up to 0.2.0 the whole deck was in "state". The first load moves it to one key per feed: each
// feed's deck is written first, then `deck` leaves the state; a run cut short in between does it
// again (cards already moved aren't added twice).
let migration: Promise<void> | null = null;

function migrated(): Promise<void> {
  migration ??= migrate().catch((e) => {
    migration = null; // try again next time; meanwhile the old deck stays where it was
    console.warn("couldn't move the deck to one key per feed:", String(e));
  });
  return migration;
}

async function migrate(): Promise<void> {
  const old = await zk.storage.get<State & { deck?: Card[] }>(STATE);
  if (!old?.deck) return;
  const seen = new Set(old.seen ?? []);
  const byFeed = new Map<string, Card[]>();
  for (const card of old.deck) {
    if (seen.has(card.id)) continue;
    byFeed.set(card.feed, [...(byFeed.get(card.feed) ?? []), capCard(card)]);
  }
  for (const [feed, cards] of byFeed) {
    await withDeck(feed, (have) => {
      const ids = new Set(have.map((c) => c.id));
      return bound([...have, ...cards.filter((c) => !ids.has(c.id))], LIMITS.deckBytes);
    });
  }
  await zk.storage.update<State & { deck?: Card[] }>(STATE, (s) => {
    if (!s) return s;
    delete s.deck;
    s.undo = (s.undo ?? []).map((step) => ({ ...step, card: capCard(step.card) }));
    return s;
  });
  console.log(`moved ${old.deck.length} cards to one storage key per feed (${byFeed.size} feeds)`);
}

/** Feed address → the name you gave it in Zotero (filled by feedList). */
let zoteroNames: Record<string, string> = {};

/** The feeds you follow, in feedList()'s order: "All feeds" deals them in this order. */
let followed: string[] = [];

/** The feeds to riffle: settings.json's, if it lists any; else the ones you follow in Zotero. */
async function feedList(): Promise<string[]> {
  const own = zk.settings.feeds ?? [];
  if (own.length) {
    followed = [...own];
    return own;
  }
  const feeds = await zk.library.feeds();
  zoteroNames = Object.fromEntries(feeds.map((f) => [f.url, f.name]));
  followed = feeds.map((f) => f.url);
  return [...followed];
}

function hostOf(feed: string): string {
  return URL.canParse(feed) ? new URL(feed).hostname : feed;
}

function feedName(s: State, feed: string | null): string {
  if (!feed) return "All feeds";
  return zoteroNames[feed] ?? s.titles[feed] ?? hostOf(feed);
}

/**
 * The address to fetch a feed at: `http://` as `https://` (zk.fetch takes only https), with any
 * `utm_*` tracking parameters left out. The feed keeps its own address as its identity: its
 * deck, its name, when it was fetched. (Exported for testing; the app ignores exports.)
 */
export function fetchUrl(feed: string): string {
  let url = feed.trim();
  if (/^http:\/\//i.test(url)) url = `https://${url.slice("http://".length)}`;
  const hashAt = url.indexOf("#");
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : url.slice(hashAt);
  const q = base.indexOf("?");
  if (q < 0) return url;
  const params = base
    .slice(q + 1)
    .split("&")
    .filter((p) => p && !/^utm_/i.test(p));
  return base.slice(0, q) + (params.length ? `?${params.join("&")}` : "") + fragment;
}

// ───────────────────────────── 2. Background: fetch, parse, dedupe ─────────────────────────────

// After a sync, at most hourly, with 30 seconds in all: fetch the feeds, longest-unfetched first
// (8 s at most each, so one slow host can't eat the run), parse each, drop what is already dealt or decided, mark what
// is already in the library, and add the rest to the feed's deck. The badge counts what is new since
// the deck was last opened; zk.ui.refresh() redraws the deck if the user is riffling right now.
zk.background(async () => {
  const added = await refreshFeeds();
  if (added > 0) {
    const fresh = await withState((s) => (s.fresh += added));
    zk.setBadge(`${fresh} new`);
  }
  zk.ui.refresh();
});

/**
 * Fetches every feed and adds its new cards to its deck. Resolves how many were added. The feed
 * fetched longest ago goes first, and each feed's cards are saved as soon as it is read: a run cut
 * short by its time limit keeps what it found, and the next run starts where it stopped.
 */
async function refreshFeeds(): Promise<number> {
  const feeds = await feedList();
  const before = await load(); // a snapshot is enough here: the merge below checks again
  const known = new Set([...before.s.seen, ...[...before.decks.values()].flat().map((c) => c.id)]);
  feeds.sort((a, b) => (before.s.fetchedAt[a] ?? 0) - (before.s.fetchedAt[b] ?? 0));
  // Each feed's share of the storage, so that all decks together stay under the 16 MB.
  const bytes = Math.min(LIMITS.deckBytes, Math.floor(LIMITS.allBytes / Math.max(1, new Set([...feeds, ...before.decks.keys()]).size)));
  let added = 0;
  for (const url of feeds) {
    const fresh: Card[] = [];
    let title: string | null = null;
    const address = fetchUrl(url);
    try {
      const res = await zk.fetch(address, { timeout: 8000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feed = parseFeed(await res.text(), url);
      title = feed.title || null;
      for (const card of feed.cards) {
        if (known.has(card.id)) continue;
        known.add(card.id);
        card.inLibrary = await inLibrary(card);
        fresh.push(card);
      }
    } catch (e) {
      // One bad feed shouldn't stop the others. (A LimitError "time" — the whole run's 30 s —
      // can't be caught: it ends the run; what was saved stays, and the next run goes on.)
      console.warn("skipped feed", url, ...(address === url ? [] : [`(fetched as ${address})`]), String(e));
    }
    let kept = 0;
    if (fresh.length) {
      await withDeck(url, async (cards) => {
        // The user may have decided meanwhile.
        const seen = new Set((await zk.storage.get<State>(STATE))?.seen ?? []);
        const have = new Set(cards.map((c) => c.id));
        const add = fresh.filter((c) => !seen.has(c.id) && !have.has(c.id));
        const after = bound([...cards, ...add], bytes);
        const left = new Set(after);
        kept = add.filter((c) => left.has(c)).length;
        return after;
      });
    }
    added += kept;
    await withState((s) => {
      if (title) s.titles[url] = title;
      s.fetchedAt[url] = Date.now();
    });
  }
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

// A verdict picks its card inside a state update, so two verdicts can't take the same card;
// then it writes the card's deck. Decided cards go into `seen` before they leave the deck.

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

/** Takes `card` out of its deck (after it went into `seen`). */
async function dropFromDeck(card: Card): Promise<void> {
  await withDeck(card.feed, (cards) => cards.filter((c) => c.id !== card.id));
}

/** Discard: the card is decided and won't come back. */
async function discard(): Promise<Card | undefined> {
  const card = await withState(async (s) => {
    const card = findCard(await viewOf(s));
    if (card) {
      s.seen.push(card.id);
      s.undo.push({ kind: "discard", card });
    }
    return card;
  });
  if (card) {
    await dropFromDeck(card);
    tally("discard");
  }
  return card;
}

/** Skip: to the back of its feed's deck, for another day. */
async function skip(): Promise<Card | undefined> {
  const card = await withState(async (s) => {
    const card = findCard(await viewOf(s));
    if (card) {
      s.undo.push({ kind: "skip", card });
      if (s.top === card.id) s.top = null;
    }
    return card;
  });
  if (card) {
    await withDeck(card.feed, (cards) => [...cards.filter((c) => c.id !== card.id), card]);
    tally("skip");
  }
  return card;
}

/**
 * Keep: creates the item in Zotero, filed into `collection`, tagged, with `note` as a child
 * note. `cardId` defaults to the top card. Resolves with the new item's key and the old items the
 * user may want to replace ({@link replaceOld}), or `null` if the card is gone.
 */
async function keep(opts: { cardId?: string; collection?: string | null; tags?: string[]; note?: string } = {}) {
  const kept = await withState(async (s) => {
    const card = findCard(await viewOf(s), opts.cardId);
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
    return { card, itemKey: created.key, replaces: card.inLibrary };
  });
  if (!kept) return null;
  await dropFromDeck(kept.card);
  tally("keep");
  return { itemKey: kept.itemKey, replaces: kept.replaces };
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
 *
 * The card stays in `seen` until it is back in its deck: a run cut short in between leaves it
 * decided, never dealt twice.
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

  await withDeck(step.card.feed, (cards) => [step.card, ...cards.filter((c) => c.id !== step.card.id)]);
  await withState((s) => {
    s.seen = s.seen.filter((id) => id !== step.card.id);
    s.top = step.card.id;
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
    followed = await feedList(); // and the names you gave them in Zotero
    const v = await load();
    const s = v.s;
    const cards = cardsIn(v);
    const top = cards[0];
    const header = zk.ui.row([
      zk.ui.text(`${feedName(s, s.current)} · ${cards.length} left`, { style: "label" }),
      zk.ui.button({ id: "feeds", title: "Feeds" }),
    ]);
    // No card left: the sitting ends on its summary, with the feeds that still have cards.
    if (!top) {
      return zk.ui.column([
        header,
        ...summary(v),
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
        await withState((s) => {
          s.fresh = 0;
        });
        sitting = { kept: 0, discarded: 0, skipped: 0, ms: 0, last: 0, dealt: cardsIn(await load()).length };
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
function summary(v: View): zk.ui.Child[] {
  const s = v.s;
  const { kept, discarded, skipped, ms, dealt } = sitting;
  const decided = kept + discarded;
  const left = cardsIn(v).length;
  const minutes = Math.round(ms / 60_000);
  const perCard = decided + skipped ? Math.round(ms / 1000 / (decided + skipped)) : 0;
  const others = feedCounts(v).filter((f) => f.count > 0 && f.feed !== s.current);
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
  render: async () => {
    followed = await feedList();
    return zk.ui.column(summary(await load()));
  },
  onEvent: async (e) => {
    if (e.kind === "select") zk.ui.close(await switchFeed(e.row));
  },
});

// ── Feeds: switch deck, or fetch now ──

/** Each feed — those you follow, then any that still has cards — with its card count. */
function feedCounts(v: View): { feed: string; count: number }[] {
  return feedOrder(v).map((feed) => ({ feed, count: v.decks.get(feed)?.length ?? 0 }));
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
    followed = await feedList();
    const v = await load();
    const s = v.s;
    const counts = feedCounts(v);
    const rows: zk.ui.ListRow[] = [
      { id: "*", title: "All feeds", meta: `${counts.reduce((n, f) => n + f.count, 0)}`, selected: s.current === null },
      ...counts.map(({ feed, count }) => ({
        id: feed,
        title: feedName(s, feed),
        subtitle: hostOf(feed),
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
  const v = await load();
  const s = v.s;
  const card = findCard(v, cardId);
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
  return { title: title || null, cards: entries.map((entry) => capCard(toCard(entry, feed))).filter((c) => c.title) };
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
