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
| **Skip** | to the back of the deck, for another day |
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
  Atom, and adds new entries to a deck kept in the plugin's storage; the badge says how many are
  new. It parses with [txml](https://www.npmjs.com/package/txml) 6.0.3 (pinned; no dependencies,
  no Node or DOM APIs), bundled into `main.js`.
- **Never deals a card twice**: a card already dealt or decided isn't dealt again.
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
