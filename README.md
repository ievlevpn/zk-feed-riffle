# Feed Riffle

[Feed Riffle](https://github.com/ievlevpn/zotero-feed-riffle) for the Kindle: clear a feed
backlog one card at a time. Written against the plugin API to test it — if this needs a
workaround, the API is wrong — and commented as a walk-through of plugin screens
(`src/main.ts`).

## Install

On the Kindle (Zotero for Kindle 0.6.0 or later): *Settings → Plugins → Get plugins → Feed Riffle →
Install*, then turn it on. It riffles the feeds you follow in Zotero (*New Feed* in Zotero's
desktop app; they sync to the Kindle with your library), under the names you gave them there.

## Use

**Plugins** on Home (the puzzle-piece icon; a dot when there are new cards) → **Feed Riffle**.
Each card shows the title, authors, date and abstract (plain text; LaTeX stays as source).

| | |
|---|---|
| swipe left, **Discard** | the card is decided and gone |
| swipe right, **Keep** | opens the filing screen |
| **Skip** | to the back of its feed's deck, for another day |
| a chip under **File into** | keeps it straight into that recent collection |
| **Undo** | takes back the last discard, skip or keep |
| **Feeds** | riffle one feed, or all of them; **Fetch now** |
| **Done** | the sitting in figures |

**Filing**: search your collections (every word typed must be in the path), pick one — the panel
starts on the one you used last — add tags (matching tags are offered as you type) and a note,
then **File into …**. Back leaves the card on top, undecided.

**In library**: a card whose DOI or arXiv id is already in your library (any arXiv version) is
marked. Filing still makes a second item; the filing screen says how many notes the old one holds,
puts the collections it is in at the top (*already in*), and offers **Move the old one to the
trash**: its notes are copied to the new item first, then the app asks you. Say no and the copies
are withdrawn. **Undo** puts it all back while unsynced; once synced, you are asked to trash the
new item, and the old one is restored in Zotero.

**The end of a sitting** — the deck running out, or **Done** — shows *17 of 24 cleared, 3 skipped
for later, 4 still to riffle*, the figures (*11 kept · 4 discarded · 3 skipped · 14 min · 47 s a
card*; a gap over five minutes isn't counted) and the feeds that still have cards: tap one to go on.

## What it does

- **Fetches feeds itself.** Zotero's feed reader isn't on the Kindle, so the background task
  (after a sync, at most hourly) fetches each of your Zotero feeds (or those in `settings.json`),
  the one fetched longest ago first, saving each feed's cards as soon as it is read. It parses RSS 2.0, RSS 1.0 or
  Atom, and adds new entries to that feed's deck in the plugin's storage; the badge says how many are
  new. It parses with [txml](https://www.npmjs.com/package/txml) 6.0.3 (pinned; no dependencies,
  no Node or DOM APIs), bundled into `main.js`.
- **Fetches `http://` feeds over `https://`** (the app fetches only https), at the same address
  otherwise, and leaves out `utm_*` tracking parameters; the feed keeps its own address as its
  name and identity. A feed that can't be fetched that way, or whose site refuses automated
  clients (`HTTP 403`, `418`), is skipped and logged once per run.
- **One deck per feed.** Each feed's undecided cards are kept in a storage key of their own,
  apart from the history (what you decided, Undo, recent collections). A feed keeps at most 150
  undecided cards — over that, its oldest are dropped (not marked decided: they are just gone) —
  and an abstract keeps its first 1,500 characters, so the plugin stays within the app's storage
  limits (1 MB a value, 16 MB in all) however long the backlog. **All feeds** deals the feeds in
  the order you follow them; **Skip** sends a card to the back of its feed's deck. A deck saved
  by 0.2.0 or earlier (in one key) is moved to the new layout the first time it is read.
- **Never deals a card twice**: a card already dealt or decided isn't dealt again, even if the
  Kindle stops between saving the verdict and saving the deck.
## Permissions

| Permission | Why |
|---|---|
| `net:*` | feeds can be on any host (arXiv, journals, blogs) |
| `library:read` | your Zotero feeds; find items by DOI or arXiv id; list collections |
| `notes:read` | read the old item's notes, to copy them when replacing it |
| `zotero:create-items` | create the kept item |
| `zotero:collections` | file it into a collection |
| `zotero:tags` | tag it |
| `zotero:notes` | add your note, and the copied notes |
| `zotero:remove` | ask to trash the old item when replacing it (and, undoing a synced keep, the new one) — your yes every time |
| `background` | fetch the feeds after a sync |

## Settings

Optional: `settings.json`, next to `plugin.json` (updates keep it):

```json
{
  "feeds": ["https://rss.arxiv.org/rss/math.PR", "https://www.example.org/atom.xml"],
  "tags": ["riffled"]
}
```

- `feeds` — RSS or Atom addresses, instead of your Zotero feeds.
- `tags` — added to every kept item, besides those chosen when keeping it.

## Build

`npm ci`, then `node build.mjs`; `npx tsc -p .` type-checks against `types/zk.d.ts` (from the
[Zotero for Kindle SDK](https://github.com/ievlevpn/zotero-for-kindle/tree/master/sdk)).

A release is `node path/to/sdk/zk-plugin.mjs pack` and `sign`, then a GitHub release tagged
`v<version>` with `dist/plugin.zip` and `dist/plugin.zip.sig`.
