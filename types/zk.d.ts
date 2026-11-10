/**
 * Zotero for Kindle — plugin API v0.
 *
 * **v0 is unstable**: names and shapes may still change; every change is listed in the API
 * changelog. A plugin declares the version it was written for in `plugin.json` (`"api": 0`).
 *
 * A plugin is one ES module (`main.js`) run by the app on QuickJS-ng (ES2023). It is neither Node
 * nor a browser: there is no `require`, no `process`, no `window` or DOM. Rely on standard
 * ES2023 and on what this file declares: the one global `zk`, plus `console`, `setTimeout` /
 * `clearTimeout`, `URL`, `URLSearchParams`, `TextEncoder` and `TextDecoder` (only the members
 * declared below). Libraries bundled into `main.js` are fine if they need nothing else.
 *
 * Everything is plain data: items, notes and annotations are JSON-like objects, the same shape
 * wherever they come from (a query, an event, an action). Everything that touches the library,
 * the network or files is `async`, because plugins run on their own thread and the screen never
 * waits for them.
 *
 * The module is run once and stays loaded while the plugin is on, so module-level variables
 * last from one call to the next (but not across restarts: keep what must last in
 * {@link zk.storage}). Calls into the plugin (event handlers, the background task, actions) may
 * interleave at each `await`, as in any async JavaScript: a read-modify-write of storage that
 * awaits in between can lose another call's write, so do it with {@link zk.Storage.update},
 * which runs a plugin's updates strictly one after another.
 *
 * Each call has a time budget (event handlers 5 s, the background task 30 s, actions and a
 * screen's `onEvent` at least 30 s, a screen's `render` 1 s). It counts from when the call starts running: time queued behind other plugins' calls
 * doesn't count, and neither does time waiting for the user to answer a confirmation (code that
 * runs meanwhile does). A call that goes over is stopped (see {@link zk.LimitError}).
 *
 * What a plugin may do is declared in `plugin.json` under `"permissions"`. Calling something not
 * declared rejects (or throws) with a {@link zk.PermissionError} that names what to add. Each
 * member below says which permission it needs.
 *
 * @packageDocumentation
 *
 * @example
 * // main.ts — log every book finished on the Kindle (needs "library:read")
 * zk.on("bookFinished", ({ item }) => {
 *   console.log(`Finished ${item.title} (${item.year ?? "n.d."})`);
 * });
 */

/**
 * Writes to the plugin's log (Settings → Plugins → the plugin, and the terminal of the desktop
 * build). Arguments are joined with spaces; objects are shown as JSON. `warn` and `error` are
 * marked as such in the log. The one way to log: standard, with levels, and what bundled
 * libraries call. No permission.
 *
 * @example
 * console.log("filed", change.key, "into", collection.path.join(" / "));
 * console.warn("feed returned no entries", url);
 */
declare var console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

// ───────────────────────────── Standard globals ─────────────────────────────
// Only the members declared here are provided.

/**
 * Runs `callback` after `ms` milliseconds, on the plugin thread. While the call that set it (an
 * event handler, the background task, an action) is still running, the callback counts against
 * that call's time budget; a timer firing after that call has finished runs as a call of its own,
 * with 5 seconds. Pending timers are dropped when the call that set them is stopped by a limit,
 * and when the plugin is turned off. Returns an id for {@link clearTimeout}. No permission.
 *
 * Quiet run time: outside calls the user caused and the background task, a plugin's code may run
 * at most 2 s in any minute (sync events, loading, and timers and continuations of calls that have
 * ended all count). Once that is used, a timer whose call has ended runs late, when the minute
 * allows — not failed, not counted. Polling with `setTimeout` works, but cheaply.
 *
 * @example
 * const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
 * for (const url of feeds) { await fetchFeed(url); await pause(500); } // be polite to the host
 */
declare function setTimeout(callback: () => void, ms?: number): number;

/**
 * Cancels a timer set with {@link setTimeout}; unknown ids are ignored. No permission.
 *
 * @example
 * const timer = setTimeout(() => console.log("slow"), 2000);
 * await work();
 * clearTimeout(timer);
 */
declare function clearTimeout(id: number | undefined): void;

/**
 * A parsed URL, as on the web (WHATWG URL). No permission.
 *
 * @example
 * const url = new URL("https://export.arxiv.org/api/query");
 * url.searchParams.set("id_list", ids.join(","));
 * const res = await zk.fetch(url.href);
 */
declare class URL {
  /** Throws a `TypeError` if `url` (resolved against `base`) isn't a valid URL. */
  constructor(url: string, base?: string | URL);
  /** Whether `new URL(url, base)` would succeed. */
  static canParse(url: string, base?: string | URL): boolean;
  href: string;
  readonly origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  readonly searchParams: URLSearchParams;
  hash: string;
  toString(): string;
  toJSON(): string;
}

/**
 * A URL's query string, as on the web. No permission.
 *
 * @example
 * const q = new URLSearchParams({ search_query: "cat:math.PR", max_results: "50" });
 * await zk.fetch(`https://export.arxiv.org/api/query?${q}`);
 */
declare class URLSearchParams implements Iterable<[string, string]> {
  constructor(init?: string | Record<string, string> | [string, string][]);
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  forEach(callback: (value: string, name: string, params: URLSearchParams) => void): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  /** The query string, without the leading `?`. */
  toString(): string;
}

/**
 * Encodes strings as UTF-8 bytes, as on the web. No permission.
 *
 * @example
 * const bytes = new TextEncoder().encode(text).length; // size of a request body
 */
declare class TextEncoder {
  constructor();
  /** Always `"utf-8"`. */
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
}

/**
 * Decodes UTF-8 bytes to a string, as on the web. Only UTF-8 is supported. No permission.
 *
 * @example
 * const text = new TextDecoder().decode(bytes);
 */
declare class TextDecoder {
  /** `fatal: true` throws a `TypeError` on invalid bytes instead of inserting U+FFFD. */
  constructor(label?: "utf-8" | "utf8", options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}

declare namespace zk {
  // ───────────────────────────── Plugin, settings, log ─────────────────────────────

  /**
   * This plugin, as installed. No permission.
   *
   * @example
   * console.log(`${zk.plugin.id} ${zk.plugin.version}, data in ${zk.plugin.dataDir}`);
   */
  const plugin: {
    /** The plugin's id from `plugin.json`; also its folder name. */
    readonly id: string;
    /** The plugin's version from `plugin.json`. */
    readonly version: string;
    /**
     * Where its `data/` folder is on the device (e.g. `/mnt/us/zotero/plugins/<id>/data`). For
     * telling the user where an export went; files are read and written with {@link zk.files}.
     */
    readonly dataDir: string;
  };

  /**
   * The user's settings for this plugin: the parsed `settings.json` next to `plugin.json`, or `{}`
   * if there is none. Read-only; the user edits the file over USB. Read when the plugin loads.
   * No permission.
   *
   * To type your settings, add their fields to {@link zk.Settings}.
   *
   * @example
   * const apiKey = zk.settings.apiKey;
   * if (typeof apiKey !== "string") throw new Error('Put your key in settings.json: { "apiKey": "…" }');
   */
  const settings: Readonly<Settings>;

  /**
   * The shape of `settings.json`. Untyped by default; a plugin describes its own by merging fields
   * into this interface.
   *
   * @example
   * // main.ts
   * declare global {
   *   namespace zk {
   *     interface Settings { apiKey?: string; language?: string }
   *   }
   * }
   * const lang = zk.settings.language ?? "English"; // string
   */
  interface Settings {
    [key: string]: Json | undefined;
  }

  // ───────────────────────────── Storage and files ─────────────────────────────

  /**
   * A private key-value store, kept in the plugin's own folder. Values are JSON (stored as with
   * `JSON.stringify`); what `get` and `update` hand back is a fresh copy, so changing it changes
   * nothing until it is stored. Survives app restarts and updates; emptied by Settings → Plugins → *Reset
   * its data*. At most 1 MB a value and 16 MB in all; a write that would go over, or one made while
   * the Kindle has less than 50 MB free, rejects with an `Error` that says so. No permission.
   *
   * @example
   * await zk.storage.set("lastRun", new Date().toISOString());
   * const seen = await zk.storage.update<string[]>("seen", (seen = []) => [...seen, entry.id]);
   */
  const storage: Storage;

  /** The type of {@link zk.storage}. */
  interface Storage {
    /**
     * The value stored under `key`, or `undefined` if there is none. `T` is what you stored; it is
     * not checked.
     *
     * @example
     * const lastRun = await zk.storage.get<string>("lastRun"); // string | undefined
     */
    get<T = Json>(key: string): Promise<T | undefined>;

    /**
     * Stores a JSON value under `key`, replacing what was there. Queued with the plugin's other
     * storage writes, so writes apply in the order they were asked (see {@link update}).
     *
     * @example
     * await zk.storage.set("lastRun", new Date().toISOString());
     */
    set(key: string, value: unknown): Promise<void>;

    /**
     * Reads, changes and writes `key` as one step: the way to do a read-modify-write. `fn` gets
     * the stored value (`undefined` if there is none) and returns the new one; returning
     * `undefined` deletes the key. Resolves with what was stored.
     *
     * All of a plugin's storage writes — `set`, `delete` and `update` — go through one queue (the
     * app keeps one per plugin) and apply in the order they were asked, one at a time: an
     * update's `fn` starts only when the writes asked before it have finished, however calls
     * interleave. So two event handlers updating the same key can't lose each other's change.
     * `fn` may be `async` and may await other calls (the library, files, `zk.zotero`) — the
     * writes after it wait, so keep it short. If `fn` throws, or its call is stopped by a limit,
     * nothing is stored, the update rejects, and the next write runs.
     *
     * Inside `fn`, write only by returning: calling `update`, `set` or `delete` there (on any
     * key) would wait for `fn` itself, so it rejects at once with an `Error`
     * ("zk.storage.update can't be called inside another update's function", or `set` /
     * `delete` for those). `get` and `keys` are fine.
     *
     * @example
     * // count, safely from any number of handlers at once
     * await zk.storage.update<number>("finished", (n = 0) => n + 1);
     *
     * @example
     * // file a card and remember it, as one step
     * const deck = await zk.storage.update<Card[]>("deck", async (deck = []) => {
     *   const [card, ...rest] = deck;
     *   if (card) await zk.zotero.createItem(fieldsOf(card));
     *   return rest;
     * });
     */
    update<T = Json>(key: string, fn: (old: T | undefined) => T | undefined | Promise<T | undefined>): Promise<T | undefined>;

    /**
     * Removes `key`. Resolves `true` if it was there. Queued with the plugin's other storage
     * writes (see {@link update}).
     *
     * @example
     * await zk.storage.delete("draft");
     */
    delete(key: string): Promise<boolean>;

    /**
     * All keys, in no particular order.
     *
     * @example
     * for (const key of await zk.storage.keys()) if (key.startsWith("feed:")) console.log(key);
     */
    keys(): Promise<string[]>;
  }

  /**
   * Text files in the plugin's own `data/` folder, for exports the user copies off over USB.
   * Paths are relative to `data/` and use `/`; a path that leaves the folder (`..`, absolute
   * paths) is refused. At most 16 MB a file and 64 MB for all of `data/`; a write that would go
   * over, or one made while the Kindle has less than 50 MB free, rejects with an `Error` that says
   * so (remove something first). No permission.
   *
   * @example
   * await zk.files.write("highlights/Gaussian random fields.md", markdown);
   * console.log("written to", `${zk.plugin.dataDir}/highlights/`);
   */
  namespace files {
    /**
     * The file's text (UTF-8). Rejects if it doesn't exist.
     *
     * @example
     * const template = await zk.files.read("template.md");
     */
    function read(path: string): Promise<string>;

    /**
     * Writes text (UTF-8), replacing the file and creating folders on the way.
     *
     * @example
     * await zk.files.write("export.md", "# My highlights\n");
     */
    function write(path: string, text: string): Promise<void>;

    /**
     * The names of the entries in a folder (default: `data/` itself); folders end with `/`.
     * Resolves `[]` for a folder that doesn't exist.
     *
     * @example
     * const exports = (await zk.files.list("highlights")).filter((n) => n.endsWith(".md"));
     */
    function list(dir?: string): Promise<string[]>;

    /**
     * Removes a file, or a folder with everything in it. Resolves `true` if it was there.
     *
     * @example
     * await zk.files.remove("highlights/old.md");
     */
    function remove(path: string): Promise<boolean>;
  }

  // ───────────────────────────── Network ─────────────────────────────

  /**
   * Fetches a URL, like the web's `fetch`, but HTTPS only, to declared hosts only, without cookies
   * and without any of the app's credentials. Responses are capped at 10 MB and requests at 30 s
   * each (less with {@link RequestInit.timeout}); going over rejects with a {@link zk.LimitError}
   * (`"responseSize"`, `"responseTime"`). A plugin may have at most 8 fetches under way at once,
   * with at most 20 MB of request bodies between them; one more rejects at once with a
   * {@link zk.LimitError} `"fetches"` (await some first).
   * `zotero.org`, every `*.zotero.org` host and the user's WebDAV host are always refused, even
   * with `net:*`. Hosts on the local network (loopback, private and link-local addresses, checked
   * on the address actually connected to) are refused too unless the host is declared by its exact
   * name (`net:<host>`); `net:*` and `net:*.<domain>` reach only the internet. An address can't be
   * declared (`net:192.168.1.5` makes plugin.json invalid).
   *
   * **Permission**: `net:<host>` for the URL's host (e.g. `"net:export.arxiv.org"`; `"net:*.example.org"`
   * covers subdomains), or `net:*` for any host. Redirects are checked the same way.
   *
   * Network errors reject with an `Error`; HTTP errors don't reject: check `ok` or `status`.
   *
   * @example
   * const res = await zk.fetch("https://export.arxiv.org/rss/math.PR");
   * if (!res.ok) throw new Error(`arXiv: HTTP ${res.status}`);
   * const xml = await res.text();
   *
   * @example
   * const res = await zk.fetch("https://api.example.org/v1/explain", {
   *   method: "POST",
   *   headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
   *   body: JSON.stringify({ text }),
   * });
   * const { answer } = await res.json<{ answer: string }>();
   */
  function fetch(url: string, init?: RequestInit): Promise<Response>;

  /** Options for {@link zk.fetch}. */
  interface RequestInit {
    /** Default `"GET"`. */
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    /**
     * Request headers, as an object or as `[name, value]` pairs (for repeated names). `Cookie` is
     * not allowed.
     */
    headers?: Record<string, string> | [string, string][];
    /**
     * Request body (sent as UTF-8, at most 10 MB; not with GET or HEAD); send JSON with
     * `JSON.stringify` and a `content-type` header.
     */
    body?: string;
    /**
     * Give up after this many milliseconds (at most, and by default, 30 000; a larger value counts
     * as 30 000), rejecting with a {@link zk.LimitError} `"responseTime"`. The time counts from the
     * call, redirects included. For calls that share a budget, e.g. several feeds fetched in one
     * 30-second background run.
     *
     * @example
     * const res = await zk.fetch(feedUrl, { timeout: 8000 });
     */
    timeout?: number;
  }

  /**
   * Response headers: a read-only subset of the web's `Headers`. Names are case-insensitive;
   * repeated headers are joined with `", "`.
   *
   * @example
   * const type = res.headers.get("Content-Type") ?? "";
   * for (const [name, value] of res.headers) console.log(name, value); // names in lower case
   */
  interface Headers extends Iterable<[string, string]> {
    /** The header's value, or `null` if it is absent. */
    get(name: string): string | null;
    /** Whether the header is present. */
    has(name: string): boolean;
    /** `[name, value]` pairs, names in lower case, sorted by name. */
    entries(): IterableIterator<[string, string]>;
    [Symbol.iterator](): IterableIterator<[string, string]>;
  }

  /** The answer to {@link zk.fetch}. The body is read whole (it is capped), and can be read again. */
  interface Response {
    /** `true` for status 200–299. */
    readonly ok: boolean;
    /** The HTTP status, e.g. `200`, `404`. */
    readonly status: number;
    /** The URL answered, after redirects. */
    readonly url: string;
    /** Response headers, as in the web's `Headers`: `res.headers.get("content-type")`. */
    readonly headers: Headers;
    /**
     * The body as text, decoded as UTF-8 whatever the response's charset (as on the web); invalid
     * bytes become U+FFFD. For another encoding, decode {@link bytes} yourself.
     */
    text(): Promise<string>;
    /**
     * The body as bytes.
     *
     * @example
     * // a Latin-1 feed
     * const xml = Array.from(await res.bytes(), (b) => String.fromCharCode(b)).join("");
     */
    bytes(): Promise<Uint8Array>;
    /** The body parsed as JSON. `T` is not checked. Rejects if it isn't JSON. */
    json<T = Json>(): Promise<T>;
  }

  // ───────────────────────────── Reading the library ─────────────────────────────

  /**
   * Reads the library as it is on the Kindle (synced from Zotero, plus changes not sent yet).
   * Everything comes back as plain objects; nothing is live.
   */
  namespace library {
    /**
     * Every item matching `query` (all items if none), in the library's order, fetched lazily —
     * so a whole library can be walked without loading it at once. Filters combine (AND). To find
     * items by words (title, creators…), use {@link search}.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * for await (const item of zk.library.items({ collection: inbox.key })) {
     *   if (!item.read) console.log(item.title);
     * }
     *
     * @example
     * // first ten items tagged "to-read"
     * for await (const item of zk.library.items({ tag: "to-read", limit: 10 })) console.log(item.title);
     */
    function items(query?: ItemsQuery): AsyncIterable<Item>;

    /**
     * One item by its key, or `null` if there is none (or it is in the trash).
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const item = await zk.library.item(annotation.itemKey);
     */
    function item(key: string): Promise<Item | null>;

    /**
     * The items with a DOI, arXiv id or ISBN — the way to ask "is this paper already in my
     * library?". DOIs match case-insensitively and with or without a `https://doi.org/` prefix;
     * arXiv ids match whatever the version suffix (`2401.01234v3` finds `2401.01234v1`); ISBNs
     * match as ISBN-10 or ISBN-13. Several identifiers match any of them. Usually zero or one item;
     * more if the library has duplicates.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const [existing] = await zk.library.findByIdentifier({ arxiv: "2401.01234v2" });
     * if (existing) console.log("already have", existing.title);
     */
    function findByIdentifier(id: { doi?: string; arxiv?: string; isbn?: string }): Promise<Item[]>;

    /**
     * All collections, each with its full path, sorted by path.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const inbox = (await zk.library.collections()).find((c) => c.path.join("/") === "Reading/Inbox");
     */
    function collections(): Promise<Collection[]>;

    /**
     * The user's Zotero feed subscriptions, as of the last sync, sorted by name. Read-only: the
     * app never changes them. Needs app 0.6.0.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const arxiv = (await zk.library.feeds()).filter((f) => f.url.startsWith("https://rss.arxiv.org/"));
     */
    function feeds(): Promise<Feed[]>;

    /**
     * All tags in the library, by name.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const names = (await zk.library.tags()).map((t) => t.name);
     */
    function tags(): Promise<Tag[]>;

    /**
     * Finds items by words, like the app's search box: matches title, creators, year, publication
     * and tags; best matches first. The one way to search; {@link items} lists by collection or tag.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const [best] = await zk.library.search("gaussian random fields adler");
     */
    function search(text: string): Promise<Item[]>;

    /**
     * An item's attachments (PDFs, EPUBs, …), whether downloaded to the Kindle or not.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const pdf = (await zk.library.attachments(item.key)).find((a) => a.downloaded);
     */
    function attachments(itemKey: string): Promise<Attachment[]>;

    /**
     * An attachment's annotations (highlights, notes, …) in reading order.
     *
     * **Permission**: `annotations:read`.
     *
     * @example
     * const highlights = (await zk.library.annotations(pdf.key)).filter((a) => a.type === "highlight");
     */
    function annotations(attachmentKey: string): Promise<Annotation[]>;

    /**
     * Annotations across the library, newest change first, fetched lazily. `since` (an ISO date)
     * stops at annotations last changed before it.
     *
     * **Permission**: `annotations:read`.
     *
     * @example
     * const lastExport = await zk.storage.get<string>("lastExport");
     * for await (const a of zk.library.recentAnnotations({ since: lastExport })) touched.add(a.itemKey);
     */
    function recentAnnotations(query?: { since?: string; limit?: number }): AsyncIterable<Annotation>;

    /**
     * An item's child notes (Zotero note items), as HTML, oldest first.
     *
     * **Permission**: `notes:read`.
     *
     * @example
     * for (const note of await zk.library.notes(old.key)) await zk.zotero.addNote(replacement.key, note.html);
     */
    function notes(itemKey: string): Promise<Note[]>;

    /**
     * The text of a downloaded book or paper (PDF, EPUB, …), extracted by the app's own engines.
     * Rejects if the attachment isn't downloaded to the Kindle (see {@link Attachment.downloaded})
     * or isn't a document, or if its text is larger than 32 MB. Can take a few seconds for a long book.
     *
     * Format: an EPUB's paragraphs are separated by a blank line (`"\n\n"`), chapters in reading
     * order. A PDF's pages are in order, separated by a form feed (`"\f"`): `text.split("\f")[0]`
     * is page 1; lines within a page end in `"\n"`.
     *
     * **Permission**: `fulltext:read`.
     *
     * @example
     * const text = await zk.library.fullText(pdf.key);
     * const words = text.split(/\s+/).length;
     */
    function fullText(attachmentKey: string): Promise<string>;
  }

  /** Filters for {@link zk.library.items}. They combine: an item must match all that are given. */
  interface ItemsQuery {
    /** Only items in this collection (its key; not its subcollections). */
    collection?: string;
    /** Only items with this tag (its name, exact). */
    tag?: string;
    /** Stop after this many items. */
    limit?: number;
  }

  // ───────────────────────────── Changing the library ─────────────────────────────

  /**
   * Asks the app to change the Zotero library. Plugins never write to Zotero themselves: the app
   * records each change, shows it in the library at once, and the sync sends it to Zotero later
   * (without ever overwriting an edit made elsewhere). Settings → Plugins → *What it changed*
   * lists every change a plugin asked for and what became of it.
   *
   * Every call changes one thing and resolves with a {@link Change}: the key of what changed and a
   * `changeId` to {@link cancel} it while it is still unsent.
   *
   * - **Adding** (items, collections, tags, notes) is allowed by its permission and resolves at once.
   * - **Removing** (trash, remove from a collection, remove a tag, delete a note) needs the user's
   *   yes every time: the app shows its own confirmation and the call resolves with the change
   *   (done) or `null` (declined, or not allowed right now) — so `if (await zk.zotero.trash(key))`
   *   reads as "if it was trashed". Removals are only asked in answer to something the user just
   *   did (an action, a screen, an event they caused on the Kindle); from a background task or an
   *   event that came in with a sync they resolve `null` without asking. Removals asked together
   *   (before awaiting any of them, e.g. with `Promise.all`) are confirmed together, in one list,
   *   with one answer for all. One call asks at most 3 questions; further removals in that call
   *   resolve `null` without asking (the log says so). Nothing is ever deleted for good except a note this plugin created:
   *   items go to Zotero's trash.
   * - **Editing** existing data (a title, a note, an annotation) is not possible in API v0.
   */
  namespace zotero {
    /**
     * Creates an item with the given metadata, optionally filed into collections and tagged.
     * One change: cancelling it withdraws the item with its collections and tags. The new item
     * is readable at once (`zk.library.item(change.key)`).
     *
     * **Permission**: `zotero:create-items`; also `zotero:collections` if `collections` isn't
     * empty, `zotero:tags` if `tags` isn't empty.
     *
     * @example
     * const change = await zk.zotero.createItem(
     *   {
     *     type: "preprint",
     *     title: entry.title,
     *     creators: entry.authors.map((name) => ({ type: "author", name })),
     *     date: entry.date,
     *     arxiv: entry.id,
     *     url: `https://arxiv.org/abs/${entry.id}`,
     *     abstract: entry.summary,
     *   },
     *   { collections: [inbox.key], tags: ["feed-riffle"] },
     * );
     * await zk.storage.set(`undo:${entry.id}`, change.changeId);
     */
    function createItem(fields: ItemFields, opts?: { collections?: string[]; tags?: string[] }): Promise<Change>;

    /**
     * Files an item into a collection (it stays in its other collections). `change.key` is the
     * item's key.
     *
     * **Permission**: `zotero:collections`.
     *
     * @example
     * await zk.zotero.addToCollection(item.key, inbox.key);
     */
    function addToCollection(itemKey: string, collectionKey: string): Promise<Change>;

    /**
     * Adds a tag to an item (nothing changes if it already has it). `change.key` is the item's key.
     *
     * **Permission**: `zotero:tags`.
     *
     * @example
     * await zk.zotero.addTag(item.key, "finished-on-kindle");
     */
    function addTag(itemKey: string, tag: string): Promise<Change>;

    /**
     * Adds a child note to an item. `html` is Zotero note HTML (paragraphs, headings, lists,
     * links, emphasis). `change.key` is the new note's key.
     *
     * **Permission**: `zotero:notes`.
     *
     * @example
     * await zk.zotero.addNote(item.key, `<p>Finished on ${new Date().toDateString()}.</p>`);
     */
    function addNote(itemKey: string, html: string): Promise<Change>;

    /**
     * Asks the user to move an item to Zotero's trash (recoverable there). Resolves with the
     * change if they said yes (`change.key` is the item's key), `null` if not. To trash several,
     * ask for them together: one confirmation lists them all.
     *
     * **Permission**: `zotero:remove`, and the user's yes each time.
     *
     * @example
     * // replace an old version with a new one, keeping its notes
     * for (const note of await zk.library.notes(old.key)) await zk.zotero.addNote(fresh.key, note.html);
     * if (!(await zk.zotero.trash(old.key))) console.log("kept the old version");
     *
     * @example
     * // several at once, in one confirmation
     * const trashed = await Promise.all(duplicates.map((d) => zk.zotero.trash(d.key)));
     */
    function trash(itemKey: string): Promise<Change | null>;

    /**
     * Asks the user to take an item out of a collection (the item stays in the library).
     *
     * **Permission**: `zotero:remove`, and the user's yes each time.
     *
     * @example
     * const removed = await zk.zotero.removeFromCollection(item.key, inbox.key); // Change | null
     */
    function removeFromCollection(itemKey: string, collectionKey: string): Promise<Change | null>;

    /**
     * Asks the user to remove a tag from an item.
     *
     * **Permission**: `zotero:remove`, and the user's yes each time.
     *
     * @example
     * await zk.zotero.removeTag(item.key, "to-read");
     */
    function removeTag(itemKey: string, tag: string): Promise<Change | null>;

    /**
     * Asks the user to delete a note — only one this plugin created (see {@link Note.createdBy});
     * any other note is refused. The one hard delete in the API.
     *
     * **Permission**: `zotero:remove`, and the user's yes each time.
     *
     * @example
     * const mine = (await zk.library.notes(item.key)).filter((n) => n.createdBy === zk.plugin.id);
     * for (const note of mine) await zk.zotero.deleteNote(note.key);
     */
    function deleteNote(noteKey: string): Promise<Change | null>;

    /**
     * Withdraws one of this plugin's changes that hasn't been sent to Zotero yet, of any kind — no
     * confirmation, since nothing leaves Zotero. Withdrawing an add takes it back (withdrawing a
     * new item also withdraws what was added to it); withdrawing a removal the user agreed to puts
     * back what it removed (an item comes back out of the trash, a deleted note comes back).
     * Resolves `true` if withdrawn, `false` if the change was already sent or isn't this plugin's.
     * Undoing a sent add is a removal: ask with {@link trash} and friends. Undoing a sent removal
     * isn't possible from a plugin (restoring is an edit); the user restores it in Zotero.
     *
     * **Permission**: none beyond the one the change needed.
     *
     * @example
     * const changeId = await zk.storage.get<string>(`undo:${entry.id}`);
     * if (changeId && !(await zk.zotero.cancel(changeId))) {
     *   await zk.zotero.trash(itemKey); // already synced: ask instead
     * }
     */
    function cancel(changeId: string): Promise<boolean>;

    /**
     * This plugin's changes not sent to Zotero yet, oldest first.
     *
     * **Permission**: none.
     *
     * @example
     * const unsent = await zk.zotero.pending();
     * zk.setBadge(unsent.length ? `${unsent.length} unsent` : null);
     */
    function pending(): Promise<PendingChange[]>;
  }

  /** What a change asked of {@link zk.zotero} resolves with (a removal: if the user said yes). */
  interface Change {
    /**
     * The key of what the change made or changed: the new item or note; the item filed, tagged,
     * trashed, or taken out of a collection or tag; the note deleted.
     */
    key: string;
    /** Identifies the change, to {@link zk.zotero.cancel} it while it is unsent. */
    changeId: string;
  }

  /** A change of this plugin's that hasn't been sent to Zotero yet ({@link zk.zotero.pending}). */
  type PendingChange = {
    /** As returned by the call that asked for it; for {@link zk.zotero.cancel}. */
    changeId: string;
    /** When it was asked for (ISO 8601). */
    requested: string;
  } & (
    | {
        kind: "createItem";
        /** The new item. */
        key: string;
        fields: ItemFields;
        /** Collections it was filed into with it (`[]` if none). */
        collections: string[];
        /** Tags it was given with it (`[]` if none). */
        tags: string[];
      }
    | { kind: "addToCollection"; /** The item. */ key: string; collection: string }
    | { kind: "addTag"; /** The item. */ key: string; tag: string }
    | { kind: "addNote"; /** The new note. */ key: string; itemKey: string }
    | { kind: "trash"; /** The item. */ key: string }
    | { kind: "removeFromCollection"; /** The item. */ key: string; collection: string }
    | { kind: "removeTag"; /** The item. */ key: string; tag: string }
    | { kind: "deleteNote"; /** The note. */ key: string }
  );

  // ───────────────────────────── Events ─────────────────────────────

  /**
   * Runs `handler` whenever `event` happens. Register handlers when the plugin loads (at the top
   * level of `main.js`). A handler has 5 seconds from when it starts running (not counting time
   * queued behind other plugins or waiting for the user's confirmation); going over stops it
   * (see {@link LimitError}: what it started is cancelled). An error it throws is logged with
   * its stack.
   *
   * Every event says where the change was made: `origin: "kindle"` (the user did it on this
   * Kindle, one event per change, as it happens) or `origin: "zotero"` (it came in with a sync:
   * one event per kind per sync, listing everything). So events that can arrive with a sync carry
   * a list — `annotations` or `items` — with one entry when the change was made on the Kindle.
   * The first full sync of a library fires only `syncFinished` (with `initial: true`).
   *
   * **Permission**: what the event carries — `annotations:read` for `highlight…` events,
   * `library:read` for `book…` and `itemMarked…` events; `syncFinished` needs none.
   *
   * @example
   * zk.on("highlightCreated", async ({ origin, annotations }) => {
   *   for (const a of annotations) console.log(origin, a.text);
   * });
   *
   * @example
   * zk.on("syncFinished", ({ initial }) => {
   *   if (!initial) console.log("synced");
   * });
   */
  function on<K extends keyof Events>(event: K, handler: (e: Events[K]) => void | Promise<void>): void;

  /** Every event {@link zk.on} can listen to, and what its handler receives. */
  interface Events {
    /** Highlights or other annotations were made. */
    highlightCreated: AnnotationsEvent;
    /** Annotations were changed (comment, colour, text). */
    highlightChanged: AnnotationsEvent;
    /** Annotations were deleted; only their keys are left. */
    highlightDeleted: {
      origin: Origin;
      annotations: Pick<Annotation, "key" | "attachmentKey" | "itemKey">[];
    };
    /** A book or paper was opened on the Kindle. */
    bookOpened: BookEvent;
    /** The user turned past the last page of a book or paper. */
    bookFinished: BookEvent;
    /** Items were marked read. */
    itemMarkedRead: ItemsEvent;
    /** Items were marked unread. */
    itemMarkedUnread: ItemsEvent;
    /** A sync with Zotero finished successfully (fires after the other events of that sync). */
    syncFinished: {
      origin: "zotero";
      /** `true` for the first full sync of a library, which fires no other events. */
      initial: boolean;
    };
  }

  /** Where a change was made: on this Kindle, or elsewhere and brought in by a sync. */
  type Origin = "kindle" | "zotero";

  /** `highlightCreated`, `highlightChanged`. */
  interface AnnotationsEvent {
    origin: Origin;
    /** The annotations, as {@link zk.library.annotations} returns them. One when `origin` is `"kindle"`. */
    annotations: Annotation[];
  }

  /** `itemMarkedRead`, `itemMarkedUnread`. */
  interface ItemsEvent {
    origin: Origin;
    /** The items, after the change. One when `origin` is `"kindle"`. */
    items: Item[];
  }

  /** `bookOpened`, `bookFinished`: these only happen on the Kindle. */
  interface BookEvent {
    origin: "kindle";
    item: Item;
    /** The file that was read. */
    attachment: Attachment;
  }

  // ───────────────────────────── Background work ─────────────────────────────

  /**
   * Registers the plugin's background task (one per plugin; registering again replaces it). The
   * app runs it after a successful sync, at most once an hour, while the Kindle is awake and
   * online; it never wakes a sleeping Kindle. A run has 30 seconds from when it starts running;
   * going over stops it (see {@link LimitError}: what it started is cancelled). Three failed runs
   * in a row
   * turn the plugin off. A background task can't show anything or ask the user: removals resolve
   * `null`; use {@link setBadge} to say there is something to see.
   *
   * **Permission**: `background`.
   *
   * @example
   * zk.background(async () => {
   *   const fresh = await refreshFeeds();
   *   zk.setBadge(fresh ? `${fresh} new` : null);
   * });
   */
  function background(task: () => void | Promise<void>): void;

  /**
   * Sets a short badge on the plugin, shown wherever the app lists it (e.g. `"42 new"`); `null`
   * clears it. Kept until changed, across restarts. Long text is cut. No permission.
   *
   * @example
   * zk.setBadge("3 new");
   */
  function setBadge(text: string | null): void;

  // ───────────────────────────── Entry points ─────────────────────────────

  /**
   * Adds an action to the reader's selection bar (what appears when the user selects text in a
   * book): the bar gets a **More…** button listing every plugin's selection actions, with the
   * plugin's name beside each. While `run` runs, the app shows "Working…"; then the result pop-up
   * shows what it returned (see {@link ActionResult}), or "<Plugin> couldn't do that: <message>"
   * if it threw. The user can close the pop-up early; the call is then stopped.
   *
   * `run` has at least 30 seconds, counted from when it starts running; time waiting for the
   * user's confirmation doesn't count. It is user-caused: it may change Zotero and ask for
   * removals.
   *
   * No permission: the selection and its item are handed over because the user chose the action.
   *
   * @example
   * zk.selectionAction({
   *   id: "explain",
   *   title: "Explain",
   *   run: async ({ text, item }) => {
   *     const answer = await explain(text, item.title);
   *     return { text: answer, actions: [{ id: "note", title: "Save as note" }] };
   *   },
   * });
   */
  function selectionAction(action: Action<TextSelection>): void;

  /**
   * Adds an action to an item's details page (the long-press sheet's *More…*), in its
   * **Plugins** section: a row with the action's title and the plugin's name. Runs and shows its
   * result as {@link selectionAction} does.
   *
   * No permission: the item is handed over because the user chose the action.
   *
   * @example
   * zk.itemAction({
   *   id: "export",
   *   title: "Export highlights",
   *   run: async (item) => `Written to ${await exportHighlights(item)}`,
   * });
   */
  function itemAction(action: Action<Item>): void;

  /** An action the user starts ({@link selectionAction}, {@link itemAction}). */
  interface Action<T> {
    /** Unique within the plugin: lowercase letters, digits and dashes. */
    id: string;
    /** What the user sees, short (one or two words). */
    title: string;
    /**
     * Does the work, and returns what the result pop-up shows (see {@link ActionResult}); a
     * thrown error is shown as "<Plugin> couldn't do that: <message>".
     *
     * When the user taps one of the pop-up's buttons (from {@link ActionReply.actions}), `run` is
     * called again with the same `target` and `again`: which button, and the text the pop-up was
     * showing. What that call returns replaces the pop-up's content; returning nothing closes it.
     *
     * @example
     * run: async ({ item }, again) => {
     *   if (again?.action === "note") {
     *     await zk.zotero.addNote(item.key, `<p>${again.text}</p>`);
     *     return "Saved as a note.";
     *   }
     *   return { text: await explain(item), actions: [{ id: "note", title: "Save as note" }] };
     * }
     */
    run(target: T, again?: ActionAgain): ActionResult | Promise<ActionResult>;
  }

  /**
   * What an action's `run` may return: text for the result pop-up (plain text; a blank line
   * separates paragraphs; paged when long), text with up to two buttons, or nothing (no pop-up).
   *
   * @example
   * return "Written to adler2007.md";
   * return { text: answer, actions: [{ id: "note", title: "Save as note" }] };
   */
  type ActionResult = string | ActionReply | void;

  /** The result pop-up with buttons of the plugin's own, beside **Close**. */
  interface ActionReply {
    /** What the pop-up shows. */
    text: string;
    /** At most 2 buttons; tapping one runs the action again (see {@link Action.run}). */
    actions?: { id: string; title: string }[];
  }

  /** What `run` gets when the user tapped one of the result pop-up's buttons. */
  interface ActionAgain {
    /** The button's `id`. */
    action: string;
    /** The text the pop-up was showing. */
    text: string;
  }

  /** What {@link selectionAction} hands to `run`. */
  interface TextSelection {
    /** The selected text. */
    text: string;
    /** The item being read. */
    item: Item;
    /** The file being read. */
    attachment: Attachment;
    /** The page label where the selection starts, if the document has pages. */
    pageLabel: string | null;
  }

  // ───────────────────────────── Screens ─────────────────────────────

  /**
   * Registers a screen of the plugin's own. A screen is described, not drawn: `render` returns a
   * tree of building blocks ({@link zk.ui.Block}, made with the {@link zk.ui} helpers or written
   * as plain objects), and the app draws it in its own style, with its fonts, header, buttons and
   * page turns. What the user does arrives as events ({@link zk.ui.Event}) at `onEvent`; after
   * each one the app calls `render` again and redraws only what changed. The plugin keeps all the
   * state (module variables, {@link zk.storage}); the app keeps none.
   *
   * A screen marked `main` is listed in the app's **Plugins** launcher (the puzzle-piece icon on
   * Home, shown when some plugin has a main screen; a dot on it when a plugin has a badge, see
   * {@link setBadge}). Other screens are opened from the plugin's own with {@link zk.ui.open}.
   *
   * The header shows `title` and the plugin's name, and its back arrow always works: the plugin
   * is told (a `back` event) but can't keep the screen open. Leaving a screen (Back, the Home
   * tab) closes it: it renders no more, and an `onEvent` call already running finishes (the
   * `back` event comes after it), but the {@link zk.ui.open}, {@link zk.ui.close} and
   * {@link zk.ui.refresh} it asks for are dropped.
   *
   * Budgets: `render` 1 s (it is usually milliseconds; it may `await` quick reads such as
   * {@link zk.storage}); `onEvent` at least 30 s, like an action (user-caused: it may change
   * Zotero and ask for removals; time waiting for the user's answer doesn't count). While
   * `onEvent` runs the screen stays drawn; taps are queued in order, and after 1 s the app shows
   * "Working…". A tree over the caps (2,000 blocks, 256 KB of text) or an invalid one, a `render`
   * that throws or goes over its budget, shows "<Plugin> can't show this screen right now" with
   * Back, and counts as a failure. An error thrown by `onEvent` is shown as an action's is
   * ("<Plugin> couldn't do that: <message>"), and the screen is rendered again.
   *
   * No permission.
   *
   * @typeParam P - What the screen is opened with: the `params` of {@link zk.ui.open} (a JSON
   *   copy), or `undefined` when opened from the launcher or without params.
   *
   * @example
   * let count = 0;
   * zk.screen("counter", {
   *   title: "Counter",
   *   main: true,
   *   render: () => zk.ui.column([
   *     zk.ui.text(`Tapped ${count} times`, { style: "title" }),
   *     zk.ui.button({ id: "more", title: "Tap", primary: true }),
   *   ]),
   *   onEvent: (e) => { if (e.kind === "tap" && e.id === "more") count++; },
   * });
   *
   * @example
   * // a screen opened with params: zk.ui.open("file", { cardId: card.id })
   * zk.screen<{ cardId: string }>("file", {
   *   title: "File",
   *   render: async ({ cardId }) => zk.ui.text((await cardById(cardId))?.title ?? "Gone"),
   * });
   */
  function screen<P = undefined>(id: string, screen: ScreenSpec<P>): void;

  /** A screen, as {@link zk.screen} registers it. */
  interface ScreenSpec<P = undefined> {
    /** Shown in the header (with the plugin's name), and in the launcher for a main screen. Short. */
    title: string;
    /** List this screen in the Plugins launcher (opened there with no params). Default `false`. */
    main?: boolean;
    /**
     * The screen as it should look now: one block, usually a {@link zk.ui.column}. Called when the
     * screen opens (after the `open` event), after every event, and on {@link zk.ui.refresh}.
     * Budget 1 s. The app compares the new tree with the last one and redraws only the top-level
     * children of the root that changed.
     */
    render(params: P): ui.Block | Promise<ui.Block>;
    /**
     * Handles what the user did ({@link zk.ui.Event}). After it returns, the screen is rendered
     * again. Budget at least 30 s. Optional: a screen that only shows things needs none.
     */
    onEvent?(event: ui.Event, params: P): void | Promise<void>;
  }

  /**
   * Building blocks for {@link zk.screen}, and the calls that open and close screens.
   *
   * Each helper returns a plain object — `zk.ui.text("Hi")` is `{ kind: "text", text: "Hi" }` —
   * so a plugin may write the objects directly. Blocks have no pixel sizes, colours, fonts or
   * images: the app lays them out on every Kindle (paging what doesn't fit, as its own lists do)
   * and picks the e-ink refresh. Every block the user can act on has an `id`, unique within the
   * screen; the events it causes name it. Where blocks take a list of children, falsy values
   * (`null`, `undefined`, `false`, `""`, `0`) are skipped, so `cond && block` works.
   *
   * Caps: 2,000 blocks (a list row, a chip or a button counts as one) and 256 KB of text a tree.
   */
  namespace ui {
    // ── Blocks ──

    /**
     * Stacks blocks top to bottom. The usual root of a screen.
     *
     * @example
     * zk.ui.column([zk.ui.text("Feeds", { style: "title" }), feedList], { gap: "medium" });
     */
    function column(children: Child[], opts?: { gap?: Gap }): ColumnBlock;

    /**
     * Places blocks side by side, sharing the width (e.g. a label and a button). Wraps nothing:
     * keep it to two or three short blocks.
     *
     * @example
     * zk.ui.row([zk.ui.text("math.PR · 12 left", { style: "label" }), zk.ui.button({ id: "feeds", title: "Feeds" })]);
     */
    function row(children: Child[], opts?: { gap?: Gap }): RowBlock;

    /**
     * Text in one of four styles; `"\n"` breaks a line. `spans` mark bold and italic stretches.
     * `lines` caps it, ending with "…".
     *
     * @example
     * zk.ui.text("Gaussian random fields", { style: "title", lines: 2 });
     * zk.ui.text(["Filed into ", { text: "Probability / SPDEs", bold: true }], { style: "meta" });
     */
    function text(text: string | Span[], opts?: { style?: TextStyle; lines?: number }): TextBlock;

    /**
     * A card: title, a meta line, a body (paged with up/down swipes when long), and a badge
     * (e.g. "In library"). Shown alone, or one at a time in a {@link deck}.
     *
     * @example
     * zk.ui.card({ title: card.title, meta: "Adler, Taylor · 2024-01-03", body: card.summary, badge: "In library" });
     */
    function card(card: Omit<CardBlock, "kind">): CardBlock;

    /**
     * Shows one card at a time; swiping it left or right sends a `swipe` event (the app turns the
     * card with the reader's page-turn feel when the next render shows another). With no card,
     * shows `empty`.
     *
     * @example
     * zk.ui.deck({ id: "cards", card: top && zk.ui.card({ title: top.title }), empty: "Nothing left to riffle" });
     */
    function deck(deck: Omit<DeckBlock, "kind">): DeckBlock;

    /**
     * Rows the user picks from, paged like the app's lists; tapping a row sends a `select`
     * event. `selected` marks a row as chosen.
     *
     * @example
     * zk.ui.list({
     *   id: "collections",
     *   rows: matches.map((c) => ({ id: c.key, title: c.path.join(" / "), selected: c.key === chosen })),
     *   empty: "No collection matches",
     * });
     */
    function list(list: Omit<ListBlock, "kind">): ListBlock;

    /**
     * A search box. Typing shows at once; `change` events are sent 700 ms after the user stops
     * typing (like the app's own searches), `submit` on Enter. See {@link FieldBlock.value} for
     * replacing the text.
     *
     * @example
     * zk.ui.search({ id: "find", placeholder: "Collection", focus: true });
     */
    function search(search: Omit<SearchBlock, "kind">): SearchBlock;

    /**
     * A text input: one line (Enter sends `submit`), or several (`lines` > 1; Enter makes a new
     * line). `change` events as for {@link search}.
     *
     * @example
     * zk.ui.field({ id: "note", label: "Note", lines: 3 });
     */
    function field(field: Omit<FieldBlock, "kind">): FieldBlock;

    /**
     * Small chips in a wrapping row: tags, recent collections. With `select: "many"` (the
     * default) each tap toggles one; `"one"` keeps at most one selected; `"none"` makes them act
     * like small buttons. Every tap sends a `chips` event. A chip given as a string is its own id
     * and title.
     *
     * @example
     * zk.ui.chips({ id: "tags", chips: ["to-read", "spde"], selected: chosen });
     * zk.ui.chips({ id: "recent", select: "none", chips: recent.map((c) => ({ id: c.key, title: c.name })) });
     */
    function chips(chips: Omit<ChipsBlock, "kind">): ChipsBlock;

    /**
     * A button, full width; tapping sends a `tap` event. `primary` for the screen's main action.
     *
     * @example
     * zk.ui.button({ id: "file", title: "File", primary: true });
     */
    function button(button: Omit<ButtonBlock, "kind">): ButtonBlock;

    /**
     * Up to 3 buttons in a row, sharing the width.
     *
     * @example
     * zk.ui.buttons([{ id: "discard", title: "Discard" }, { id: "skip", title: "Skip" }, { id: "keep", title: "Keep", primary: true }]);
     */
    function buttons(buttons: (Omit<ButtonBlock, "kind"> | Falsy)[]): ButtonsBlock;

    /**
     * A thin line between sections.
     *
     * @example
     * zk.ui.column([summary, zk.ui.divider(), feedList]);
     */
    function divider(): DividerBlock;

    /**
     * Empty space (default `"medium"`).
     *
     * @example
     * zk.ui.space("large");
     */
    function space(size?: Size): SpaceBlock;

    /**
     * A quiet one-line message: the outcome of the last step, a hint.
     *
     * @example
     * zk.ui.notice("Discarded. 3 cards skipped for later.");
     */
    function notice(text: string): NoticeBlock;

    // ── Navigation ──

    /**
     * Opens one of the plugin's screens over the current one, with `params` (copied as JSON) for
     * its `render` and `onEvent`. Takes effect when the current call ends. Only in answer to the
     * user: from `onEvent` or an action's `run`; elsewhere (the background task, an event
     * handler) it throws an `Error`.
     *
     * @example
     * onEvent: (e) => {
     *   if (e.kind === "swipe" && e.direction === "right") zk.ui.open("file", { cardId: top.id });
     * }
     */
    function open(screenId: string, params?: unknown): void;

    /**
     * Closes the screen whose `onEvent` is running, when that call ends. The screen below gets a
     * `result` event with `result` (copied as JSON). Throws an `Error` outside `onEvent`.
     *
     * @example
     * if (e.kind === "tap" && e.id === "file") { await fileIt(); zk.ui.close("Filed into Probability"); }
     */
    function close(result?: unknown): void;

    /**
     * Renders the plugin's showing screen again, if one is showing: after work outside `onEvent`
     * changed what it shows (a background refresh brought new cards). Callable from anywhere;
     * does nothing when no screen of the plugin is showing.
     *
     * @example
     * zk.background(async () => { await refreshFeeds(); zk.ui.refresh(); });
     */
    function refresh(): void;

    // ── Types ──

    /** A building block: what `render` returns, and what layout blocks contain. */
    type Block =
      | ColumnBlock
      | RowBlock
      | TextBlock
      | CardBlock
      | DeckBlock
      | ListBlock
      | SearchBlock
      | FieldBlock
      | ChipsBlock
      | ButtonBlock
      | ButtonsBlock
      | DividerBlock
      | SpaceBlock
      | NoticeBlock;

    /** A child of a layout block, or a falsy value to skip (so `cond && block` works). */
    type Child = Block | Falsy;

    /** What a list of children skips. */
    type Falsy = null | undefined | false | "" | 0;

    /** Spacing between children. */
    type Gap = "none" | "small" | "medium" | "large";

    /** A size of {@link space}. */
    type Size = "small" | "medium" | "large";

    /** `title` (large), `body` (reading text), `meta` (small, dimmed), `label` (small caps-like). */
    type TextStyle = "title" | "body" | "meta" | "label";

    /** A stretch of text, bold or italic. */
    type Span = string | { text: string; bold?: boolean; italic?: boolean };

    /** See {@link column}. */
    interface ColumnBlock {
      kind: "column";
      children: Child[];
      /** Default `"small"`. */
      gap?: Gap;
    }

    /** See {@link row}. */
    interface RowBlock {
      kind: "row";
      children: Child[];
      /** Default `"small"`. */
      gap?: Gap;
    }

    /** See {@link text}. */
    interface TextBlock {
      kind: "text";
      text: string | Span[];
      /** Default `"body"`. */
      style?: TextStyle;
      /** At most this many lines, ending with "…". */
      lines?: number;
    }

    /** See {@link card}. */
    interface CardBlock {
      kind: "card";
      title: string;
      /** One line under the title (authors · date). */
      meta?: string;
      /** Plain text; a blank line separates paragraphs. Paged with up/down swipes when long. */
      body?: string;
      /** A short mark in the card's corner. */
      badge?: string;
    }

    /** See {@link deck}. */
    interface DeckBlock {
      kind: "deck";
      id: string;
      /** The card on top; `null` (or absent) when there is none. */
      card?: CardBlock | null;
      /** Shown when there is no card. */
      empty?: string;
    }

    /** See {@link list}. */
    interface ListBlock {
      kind: "list";
      id: string;
      rows: ListRow[];
      /** Shown when there are no rows. */
      empty?: string;
    }

    /** A row of a {@link list}. */
    interface ListRow {
      /** Unique within the list; the `select` event names it. */
      id: string;
      title: string;
      /** A second line. */
      subtitle?: string;
      /** Small text at the right (a count, a date). */
      meta?: string;
      /** A short mark ("already in"). */
      badge?: string;
      /** Marked as chosen. */
      selected?: boolean;
    }

    /** See {@link search}. */
    interface SearchBlock {
      kind: "search";
      id: string;
      placeholder?: string;
      /** As {@link FieldBlock.value}. */
      value?: string;
      /** Has the keyboard when the screen opens. */
      focus?: boolean;
    }

    /** See {@link field}. */
    interface FieldBlock {
      kind: "field";
      id: string;
      /** A small label above the input. */
      label?: string;
      placeholder?: string;
      /**
       * The text to show. Omitted, the app keeps whatever the user typed. Given, the app shows it
       * whenever it differs from the text last sent to the plugin in a `change` or `submit`
       * event — so a plugin that keeps the text can replace it (clear a tag box after `submit`)
       * without ever undoing what is being typed.
       */
      value?: string;
      /** Lines tall; more than 1 makes Enter a new line instead of `submit`. Default 1. */
      lines?: number;
      /** Has the keyboard when the screen opens. */
      focus?: boolean;
    }

    /** See {@link chips}. */
    interface ChipsBlock {
      kind: "chips";
      id: string;
      /** A string is its own id and title. */
      chips: (string | { id: string; title: string })[];
      /** Ids of the selected chips. */
      selected?: string[];
      /** Default `"many"`. */
      select?: "none" | "one" | "many";
    }

    /** See {@link button}. */
    interface ButtonBlock {
      kind: "button";
      id: string;
      title: string;
      /** The screen's main action, drawn filled. */
      primary?: boolean;
    }

    /** See {@link buttons}. */
    interface ButtonsBlock {
      kind: "buttons";
      /** At most 3. */
      buttons: (Omit<ButtonBlock, "kind"> | Falsy)[];
    }

    /** See {@link divider}. */
    interface DividerBlock {
      kind: "divider";
    }

    /** See {@link space}. */
    interface SpaceBlock {
      kind: "space";
      /** Default `"medium"`. */
      size?: Size;
    }

    /** See {@link notice}. */
    interface NoticeBlock {
      kind: "notice";
      text: string;
    }

    /**
     * What `onEvent` receives. Events arrive one at a time, in the order they happened; a
     * pending `change` (typing not yet sent) is always sent before any other event of the same
     * screen, so a tap on "File" sees the note just typed.
     *
     * - `open` — the screen is opening; first, before its first render ("Loading…" shows until
     *   it returns). For set-up slower than `render`'s 1 s.
     * - `tap` — a {@link button}, or one of {@link buttons}, by its `id`.
     * - `select` — a {@link list} row: `id` is the list's, `row` the row's.
     * - `swipe` — the {@link deck}'s card, left or right.
     * - `change` / `submit` — a {@link search} or {@link field}: its whole text.
     * - `chips` — a chip tapped: which one, and the selection it makes (keep it and render it as
     *   `selected`, or the chips go back as they were).
     * - `result` — a screen this one opened has closed: its id and what {@link close} gave
     *   (`undefined` if closed with Back or without a result).
     * - `back` — the user left this screen. It is already closed; nothing is rendered after.
     *
     * @example
     * onEvent: async (e) => {
     *   if (e.kind === "swipe") await (e.direction === "left" ? discard() : keep());
     *   else if (e.kind === "tap" && e.id === "undo") message = await undo();
     *   else if (e.kind === "result" && typeof e.value === "string") message = e.value;
     * }
     */
    type Event =
      | { kind: "open" }
      | { kind: "tap"; id: string }
      | { kind: "select"; id: string; row: string }
      | { kind: "swipe"; id: string; direction: "left" | "right" }
      | { kind: "change"; id: string; text: string }
      | { kind: "submit"; id: string; text: string }
      | { kind: "chips"; id: string; chip: string; selected: string[] }
      | { kind: "result"; from: string; value: Json | undefined }
      | { kind: "back" };
  }

  // ───────────────────────────── Data ─────────────────────────────

  /**
   * A library item (a paper, book, …), the same shape wherever it comes from. Fields Zotero leaves
   * empty are `null`; lists are empty arrays.
   */
  interface Item {
    /** Zotero's key, e.g. `"ABCD2345"`. */
    key: string;
    /** Zotero's item type. */
    type: ItemType;
    /** The title; `""` if it has none. */
    title: string;
    /** Authors, editors, … in order. */
    creators: Creator[];
    /** The year, parsed from `date`. */
    year: number | null;
    /** The date as entered in Zotero (free-form, e.g. `"2024-01-03"` or `"March 2019"`). */
    date: string | null;
    /** Journal, book, proceedings or website title. */
    publication: string | null;
    /** The DOI, without a `https://doi.org/` prefix. */
    doi: string | null;
    /** The arXiv id, without a version suffix (`"2401.01234"`). */
    arxiv: string | null;
    isbn: string | null;
    url: string | null;
    abstract: string | null;
    /** Tag names. */
    tags: string[];
    /** Keys of the collections it is in. */
    collections: string[];
    /** Whether it is marked read. */
    read: boolean;
    /** Zotero's *Extra* field. */
    extra: string | null;
    /**
     * The citation key: Zotero's own `citationKey` field when it has one, else the
     * `Citation Key:` line Better BibTeX writes into *Extra*.
     */
    citationKey: string | null;
  }

  /** Zotero item types. Others exist; these are the common ones. */
  type ItemType =
    | "journalArticle"
    | "preprint"
    | "book"
    | "bookSection"
    | "conferencePaper"
    | "thesis"
    | "report"
    | "manuscript"
    | "webpage"
    | "document"
    | (string & {});

  /** A creator of an item: a person (`first`, `last`) or an organisation (`name`). */
  interface Creator {
    /** `"author"`, `"editor"`, … */
    type: "author" | "editor" | "contributor" | "translator" | (string & {});
    first?: string;
    last?: string;
    /** A single-field name, for organisations or names that don't split. */
    name?: string;
  }

  /** The metadata {@link zk.zotero.createItem} takes. `type` and `title` are required. */
  interface ItemFields {
    type: ItemType;
    title: string;
    creators?: Creator[];
    /** Free-form, as in Zotero; ISO (`"2024-01-03"`) is best. */
    date?: string;
    publication?: string;
    doi?: string;
    /** The arXiv id (a version suffix is kept as given). */
    arxiv?: string;
    isbn?: string;
    url?: string;
    abstract?: string;
    extra?: string;
  }

  /** A collection. */
  interface Collection {
    key: string;
    name: string;
    /** The parent collection's key; `null` at the top level. */
    parent: string | null;
    /** Names from the top level down, ending with its own: `["Reading", "arXiv"]`. */
    path: string[];
  }

  /** A Zotero feed subscription. */
  interface Feed {
    url: string;
    /** Its name in Zotero; the URL if it has none. */
    name: string;
  }

  /** A tag in the library. */
  interface Tag {
    name: string;
    /** How many items have it. */
    count: number;
  }

  /** A file attached to an item. */
  interface Attachment {
    key: string;
    /** The item it belongs to. */
    itemKey: string;
    title: string;
    /** E.g. `"application/pdf"`, `"application/epub+zip"`. */
    contentType: string;
    filename: string | null;
    /** Whether the file is on the Kindle (needed for {@link zk.library.fullText}). */
    downloaded: boolean;
  }

  /** An annotation in a book or paper. */
  interface Annotation {
    key: string;
    /** The file it is in. */
    attachmentKey: string;
    /** The item that file belongs to. */
    itemKey: string;
    type: "highlight" | "underline" | "note" | "image" | "ink";
    /** The highlighted text (`null` for notes and images). */
    text: string | null;
    /** The user's comment. */
    comment: string | null;
    /** As in Zotero, e.g. `"#ffd400"`. */
    color: string;
    /** The page label shown in the document, e.g. `"12"` or `"xii"`. */
    pageLabel: string | null;
    tags: string[];
    /** ISO 8601. */
    created: string;
    /** ISO 8601. */
    modified: string;
  }

  /** A Zotero note attached to an item. */
  interface Note {
    key: string;
    /** The item it belongs to. */
    itemKey: string;
    /** The note's HTML, as Zotero stores it. */
    html: string;
    /** The id of the plugin that created it, or `null` (made in Zotero). */
    createdBy: string | null;
    /** ISO 8601. */
    created: string;
    /** ISO 8601. */
    modified: string;
  }

  /** A JSON value. */
  type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

  // ───────────────────────────── Permissions and errors ─────────────────────────────

  /** A permission, as written in `plugin.json`. */
  type Permission =
    | "library:read"
    | "annotations:read"
    | "fulltext:read"
    | "notes:read"
    | `net:${string}`
    | "zotero:create-items"
    | "zotero:collections"
    | "zotero:tags"
    | "zotero:notes"
    | "zotero:remove"
    | "background";

  /**
   * Thrown (or rejected with) when the plugin calls something its `plugin.json` doesn't declare.
   * The message says what to add, e.g.
   * `zk.fetch("https://api.deepl.com/…") needs "net:api.deepl.com" in plugin.json`.
   *
   * @example
   * try {
   *   await zk.library.fullText(pdf.key);
   * } catch (e) {
   *   if (e instanceof zk.PermissionError) console.log("missing", e.permission);
   *   else throw e;
   * }
   */
  class PermissionError extends Error {
    /** Only the app makes these. */
    private constructor();
    readonly name: "PermissionError";
    /** The permission that was missing, exactly as it must appear in `plugin.json`. */
    readonly permission: Permission;
  }

  /**
   * Thrown (or rejected with) when the plugin goes over one of the app's limits; the message names
   * it. `time`, `memory` and `stack` stop the running handler or task; the fetch limits
   * (`responseSize`, `responseTime`, `fetches`) only fail that fetch.
   *
   * `time` is the call's budget: event handlers 5 s, the background task 30 s, actions and a
   * screen's `onEvent` at least 30 s, a screen's `render` 1 s. It counts from when the call starts running; time queued behind other plugins' calls
   * and time waiting for the user to answer a confirmation never count. `memory` is 32 MB for a
   * plugin, and 96 MB for all plugins together: a call whose allocation would pass either is
   * stopped.
   *
   * When a call is stopped, the work it started in the app (fetches, library reads, storage and
   * file operations, timers) is cancelled, and every promise of that work still pending rejects
   * with a `LimitError` — none is left pending forever. So {@link Storage.update}'s queue, or any
   * queue a plugin keeps itself, moves on to the next job instead of hanging. Changes to Zotero
   * already asked for stay asked for (each resolved at once); a removal still waiting for the
   * user's answer is withdrawn. Code that catches the `LimitError` can't start new work for the
   * stopped call: such calls reject at once with the same `LimitError`.
   *
   * After a limit stop that cut into running code (not just a call left waiting too long), the
   * plugin is restarted: `main.js` runs afresh in a new runtime, so module-level variables start
   * over. Keep anything that must survive in {@link zk.storage}. Every stop counts as a failure;
   * three failures in a row turn the plugin off.
   *
   * @example
   * try {
   *   const res = await zk.fetch(bigFeedUrl);
   * } catch (e) {
   *   if (e instanceof zk.LimitError && e.limit === "responseSize") console.log("feed too large");
   *   else throw e;
   * }
   */
  class LimitError extends Error {
    /** Only the app makes these. */
    private constructor();
    readonly name: "LimitError";
    /**
     * Which limit: run time, memory, stack depth, a fetch's response size or duration, or too many
     * fetches under way at once.
     */
    readonly limit: "time" | "memory" | "stack" | "responseSize" | "responseTime" | "fetches";
  }
}
