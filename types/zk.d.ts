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
 * A delay under 100 ms (or none) is raised to 100 ms. A plugin may have at most 1000 timers
 * pending; one more throws a {@link zk.LimitError} `"timers"` (nothing is set).
 *
 * While the app is in the background (another Kindle app or the screensaver is up), a timer whose
 * call has ended doesn't fire: it waits and runs, late, when the app is back in front. Timers of a
 * call still running fire as usual.
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
     * Where its `data/` folder is on the device (e.g. `/mnt/us/zotero/accounts/<userID>/plugins/<id>/data`: the active account's). For
     * telling the user where an export went; files are read and written with {@link zk.files}.
     */
    readonly dataDir: string;
  };

  /**
   * The app's window, for a screen that adapts to its size (a Home that drops a large block on a
   * short screen). Lengths are layout pixels at 300 ppi, the unit the app lays out in, so the same
   * physical size on every Kindle: a Paperwhite 5 is 1236 × 1547, a Scribe 1860 × 2379, a basic
   * Kindle (KT4) 1078 × 1337. Read when asked: `landscape` turns with the device (only the reader
   * turns; the app's screens, Home and plugin screens, are portrait). No permission. Needs app 0.11.0.
   *
   * @example
   * const short = zk.display.height < 1400; // a basic Kindle: keep Home's top compact
   */
  const display: {
    /** The window's width in pixels at 300 ppi. */
    readonly width: number;
    /** The window's height (the screen under the status bar), in pixels at 300 ppi. */
    readonly height: number;
    /**
     * The Kindle: `"pw5"`, `"kt4"` or `"scribe"`, else the device's name in lower case without
     * spaces. The desktop build reports the Kindle it imitates.
     */
    readonly model: "pw5" | "kt4" | "scribe" | (string & {});
    /** Wider than tall. */
    readonly landscape: boolean;
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
     * All collections, each with its full path: My Library's first, then each group library's
     * (see {@link libraries}), each sorted by path.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * const inbox = (await zk.library.collections()).find((c) => c.libraryId === 0 && c.path.join("/") === "Reading/Inbox");
     */
    function collections(): Promise<Collection[]>;

    /**
     * The libraries on the Kindle: My Library (`id` 0) first, then the user's Zotero group
     * libraries that sync (switched on in Settings → Group libraries, and still available), by
     * name. Items, collections and annotations carry their library's `libraryId` and
     * `libraryName`. Needs app 0.8.0.
     *
     * **Permission**: `library:read`.
     *
     * @example
     * for (const lib of await zk.library.libraries())
     *   if (!lib.editable) console.log(`${lib.name}: read-only, changes there are refused`);
     */
    function libraries(): Promise<LibraryInfo[]>;

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
     * A plugin has at most 4 of these under way at once (plugins take turns on one reader): a fifth
     * rejects at once; await some before asking for more.
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

    /**
     * Opens an item in the app's reader, as if the user had tapped it in the library: its
     * attachment (the one named by `options.attachment`, else the one the app would open) opens at
     * the reading place saved on this Kindle, downloading first if needed. Back returns to the
     * screen as it was, and the screen gets a `{ kind: "reader", closed: true }` event.
     *
     * Only in answer to the user (a screen's `onEvent`, an action's `run`), like
     * {@link zk.reader.open}; from a background task or a timer it throws, and nothing opens. The
     * promise resolves when the reader shows, and rejects with the reason when it can't: the item
     * is gone or unreadable (`"Item not found"`), the download failed, or the user cancelled it
     * (`"Cancelled"`). An unknown key never opens anything. Given as `{ key, library }`, the key is
     * looked up in that library; with `library` omitted (or a plain key) the app finds the item
     * by its key across the libraries it shows.
     *
     * With `annotation` (an {@link Annotation}'s key, needs app 0.11.0) the reader opens the file
     * that annotation is in and goes to it, as a tap in the app's Notes does. An annotation that
     * is unknown, deleted, another item's, or not in the `attachment` given rejects with
     * `"Annotation not found"`; on an app before 0.11.0 the option is ignored and the item opens
     * where it was left.
     *
     * **Permission**: `library:read`. Needs app 0.10.0.
     *
     * @example
     * if (e.kind === "tap" && e.id === "continue") await zk.library.open(lastKey);
     * @example
     * await zk.library.open({ key: item.key, library: item.libraryId }, { attachment: pdf.key });
     * @example
     * // a highlight, tapped: the reader opens at it (app 0.11.0)
     * await zk.library.open(passage.itemKey, { annotation: passage.key });
     */
    function open(
      item: string | { key: string; library?: number },
      options?: { attachment?: string; annotation?: string },
    ): Promise<void>;
  }

  /** Filters for {@link zk.library.items}. They combine: an item must match all that are given. */
  interface ItemsQuery {
    /** Only items in this collection (its key; not its subcollections). */
    collection?: string;
    /** Only items with this tag (its name, exact). */
    tag?: string;
    /** Only items of this library: 0 My Library, else a group's id ({@link zk.library.libraries}). Needs app 0.8.0. */
    library?: number;
    /** Stop after this many items. */
    limit?: number;
    /**
     * `true`: only items opened on this Kindle, the most recently opened first (the order of the
     * app's Recent list). Needs app 0.10.0.
     *
     * @example
     * for await (const item of zk.library.items({ opened: true, limit: 5 })) console.log(item.title, item.progress);
     */
    opened?: true;
    /**
     * Only items marked read (`true`) or not marked read (`false`): the read mark, never
     * progress. Needs app 0.10.0.
     */
    read?: boolean;
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
   * - **Group libraries**: a change goes to the library of what it changes (a new item to its
   *   collections' library; none means My Library). It is refused, with a message saying why, when
   *   that group is read-only for the user, switched off on the Kindle or no longer available, and
   *   when it mixes libraries (collections of two libraries, or an item filed into another
   *   library's collection). See {@link zk.library.libraries} (`editable`).
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
   * A plugin may register at most 100 handlers for each event; one more throws a
   * {@link LimitError} `"handlers"` (it isn't registered).
   *
   * Every event says where the change was made: `origin: "kindle"` (the user did it on this
   * Kindle, one event per change, as it happens) or `origin: "zotero"` (it came in with a sync:
   * one event per kind per sync, listing everything). So events that can arrive with a sync carry
   * a list — `annotations` or `items` — with one entry when the change was made on the Kindle.
   * The first full sync of a library fires only `syncFinished` (with `initial: true`). That holds for
   * each group library too: the sync in which a group is first downloaded (newly joined, or switched
   * on again after its copy was removed) ends with `initial: true`, even when My Library had synced
   * before, so a plugin that keeps an index rebuilds it then.
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
      /**
       * `true` when this sync was the first full sync of any library — My Library or a group — which
       * fires no other events for that library.
       */
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
    /** The item being read; `null` in a preview ({@link zk.reader.open}, app 0.9.0). */
    item: Item | null;
    /** The file being read; `null` in a preview. */
    attachment: Attachment | null;
    /** In a preview (app 0.9.0): what is being read instead of an item. */
    preview?: { title: string; url: string | null };
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
    /**
     * Offer this screen as the body of the app's Home (Settings → Home lists it as
     * "<title> — <plugin name>"; the user picks one). Default `false`. Needs app 0.10.0.
     *
     * The app keeps Home's frame: the title and sync line, the Plugins, settings, sync and close
     * icons, the search field, the error, safe-mode and update banners, and the tab bar. The screen
     * draws only the body between the search field and the banners/tab bar, and its `render` takes
     * no params. The body may hold every block except {@link zk.ui.search} and {@link zk.ui.field};
     * a tree with one is invalid for Home.
     *
     * Home falls back to the app's built-in body, with no message, when plugins are off (safe mode,
     * stopped for an install), the chosen plugin is disabled, removed or incompatible or has no such
     * screen, no tree has been drawn yet and the first one doesn't arrive within 1 s (the last tree
     * is kept and drawn first on the next start), or `render`/`onEvent` fails. The next time Home
     * shows, the plugin is tried again. A periodic sync that changes nothing repaints nothing.
     *
     * @example
     * zk.screen("home", {
     *   title: "Reading now",
     *   home: true,
     *   render: async () => {
     *     const keys: string[] = [];
     *     for await (const i of zk.library.items({ opened: true, limit: 3 })) keys.push(i.key);
     *     return zk.ui.column([zk.ui.items({ id: "recent", style: "card", items: keys, empty: "Nothing opened yet" })]);
     *   },
     * });
     */
    home?: boolean;
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
    function column(children: Child[], opts?: { gap?: Gap; fit?: "page" | "trim"; width?: Width }): ColumnBlock;

    /**
     * Places blocks side by side (e.g. a label and a button), up to 12. Wraps nothing: keep it
     * to a few short blocks. Each child takes what its `width` says (see {@link Width}); the
     * rest of the width is shared equally by the children that `fill` (the default; buttons are
     * `"auto"`). `align` places the children vertically when they differ in height (centred unless
     * it says, as before 0.12); with `"stretch"` each is as tall as the row, and a {@link spacer} in a stretched column takes
     * the leftover height. `align` and the 12 blocks need app 0.12.0 (older apps: 6 blocks).
     *
     * @example
     * zk.ui.row([zk.ui.text("math.PR · 12 left", { style: "label" }), zk.ui.button({ id: "feeds", title: "Feeds" })]);
     */
    function row(children: Child[], opts?: { gap?: Gap; align?: RowAlign; width?: Width }): RowBlock;

    /**
     * Text in one of four styles; `"\n"` breaks a line. `spans` mark bold and italic stretches.
     * `lines` caps it, ending with "…".
     *
     * @example
     * zk.ui.text("Gaussian random fields", { style: "title", lines: 2 });
     * zk.ui.text(["Filed into ", { text: "Probability / SPDEs", bold: true }], { style: "meta" });
     */
    function text(text: string | Span[], opts?: TextOptions): TextBlock;

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
     * A deck is the screen's main thing: in a screen's top-level {@link column} it takes all the
     * height the other blocks leave, and the blocks after it sit at the bottom of the screen. Every
     * card — short, long, or none — has that same size, so nothing around it moves from card to
     * card; a long body pages inside the card (up/down swipes, "2 / 3" in its corner). Needs app
     * 0.9.0 (before, a deck took its card's height).
     *
     * Tapping the card sends a `tap` event with the deck's `id` (e.g. to open the paper with
     * {@link zk.reader.open}). Needs app 0.9.0.
     *
     * @example
     * zk.ui.deck({ id: "cards", card: top && zk.ui.card({ title: top.title }), empty: "Nothing left to riffle" });
     */
    function deck(deck: Omit<DeckBlock, "kind">): DeckBlock;

    /**
     * Library items drawn by the app: a `card` (title, authors, progress) or a `row` per item, or
     * a `shelf` of cover tiles, paged like the app's lists. The app resolves the keys itself, so the rows always show the
     * item's current title and reading progress, and repaints just this block when they change.
     * Items that are missing, in a switched-off group or unreadable are skipped silently; if all
     * are, `empty` shows (none: the block draws nothing).
     *
     * **Taps and long-presses never reach the plugin**: a tap opens the item in the reader (the
     * screen then gets a `{ kind: "reader", closed: true }` event when it closes), a long-press
     * shows the library's own item menu. Use {@link zk.library.open} to open one in answer to
     * your own button. Reading the items needs `library:read`. Needs app 0.10.0.
     *
     * @example
     * zk.ui.items({ id: "recent", style: "row", items: keys, empty: "Nothing opened yet" });
     * @example
     * // an item from a group library, with its own label
     * zk.ui.items({ id: "pick", style: "card", items: [{ key: "ABCD2345", library: 12, label: "Up next" }] });
     * @example
     * // the books being read, as covers (needs app 0.11.0)
     * zk.ui.items({ id: "shelf", style: "shelf", items: reading.map((i) => i.key), empty: "Nothing on the shelf" });
     */
    function items(items: Omit<ItemsBlock, "kind">): ItemsBlock;

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
     * A quiet one-line message: the outcome of the last step, a hint. With an `id`, tapping it
     * sends a `tap` event with that id (needs app 0.9.0).
     *
     * @example
     * zk.ui.notice("Discarded. 3 cards skipped for later.");
     * zk.ui.notice("Kept into Probability", { id: "read-kept" }); // tap: read it
     */
    function notice(text: string, opts?: { id?: string }): NoticeBlock;

    /**
     * A passage set apart: its text in italics with a rule on its left, at most 5 lines (a longer
     * one ends with "…"), and its `source` on a line under it. With an `id`, tapping it sends a
     * `tap` event with that id (open the highlight with {@link zk.library.open}'s `annotation`).
     * Line breaks in `text` are kept; spaces around it are not. May be on Home's body. Needs app
     * 0.11.0.
     *
     * @example
     * zk.ui.quote({ text: "It is a truth universally acknowledged…", source: "Pride and Prejudice · p. 1" });
     * @example
     * zk.ui.quote({ id: "passage", text: a.text ?? "", source: `${item.title} · p. ${a.pageLabel}` });
     * // onEvent: if (e.kind === "tap" && e.id === "passage") await zk.library.open(item.key, { annotation: a.key });
     */
    function quote(quote: { id?: string; text: string; source?: string }): QuoteBlock;

    /**
     * Flexible empty space: in a column that is as tall as its row (a row with `align:
     * "stretch"`) it takes the height the other children leave; anywhere else it takes no room.
     * Needs app 0.12.0.
     *
     * @example
     * zk.ui.row([cover, zk.ui.column([title, zk.ui.spacer(), zk.ui.progress(0.4)])], { align: "stretch" });
     */
    function spacer(): SpacerBlock;

    /**
     * A frame around one block: padding, a border, a fill, rounded corners. Text inside an `"ink"`
     * box is drawn white unless its own `tone` says otherwise. With an `id`, tapping it sends a
     * `tap` event with that id: the way to make a custom button, a link, a segmented switch.
     * Needs app 0.12.0.
     *
     * @example
     * zk.ui.box(zk.ui.text("Week", { tone: "inverse" }), { id: "week", pad: "small", fill: "ink", radius: "round" });
     */
    function box(child: Block, opts?: { id?: string; pad?: Gap; border?: Border; fill?: Fill; radius?: Radius; width?: Width }): BoxBlock;

    /**
     * An item's cover as the app draws it, 2:3, as wide as `width` says (default `"fill"`).
     * Needs app 0.12.0.
     *
     * @example
     * zk.ui.cover(book.key, { width: "25%" });
     */
    function cover(item: ItemRef, opts?: { width?: Width }): CoverBlock;

    /**
     * The app's thin progress bar, `value` from 0 to 1. Needs app 0.12.0.
     *
     * @example
     * zk.ui.progress(0.4);
     */
    function progress(value: number, opts?: { width?: Width }): ProgressBlock;

    /**
     * Makes any block an item: a tap opens it as the app opens items (download, the choice of a
     * file, the reader), a long press shows its item sheet, and while it downloads the app draws
     * the status in a small bar over the bottom of the block. An item that can't be read: the
     * block is drawn but does nothing. Needs app 0.12.0.
     *
     * @example
     * zk.ui.item(book.key, zk.ui.row([zk.ui.cover(book.key, { width: "20%" }), zk.ui.text(book.title)]));
     */
    function item(item: ItemRef, child: Block): ItemBlock;

    /**
     * Cells in rows. `columns`: a number from 1 to 12, or `"auto"` (the default): as many as fit
     * with each at least `minWidth` (5% to 100% of the grid, default `"25%"`). It pages by rows
     * like the app's lists, unless `rows` (1 to 20) is given: then only that many rows are drawn,
     * the rest are not, and it never pages. Needs app 0.12.0.
     *
     * @example
     * zk.ui.grid(books.map((b) => zk.ui.item(b.key, zk.ui.cover(b.key))), { columns: 4, rows: 1 });
     */
    function grid(children: Child[], opts?: { columns?: number | "auto"; minWidth?: Percent; gap?: Gap; rows?: number; width?: Width }): GridBlock;

    /**
     * A PNG from the plugin's package, drawn in greys with its aspect kept. `src` is a path in
     * the package (never absolute, never with `..`). With an `id` it is tappable. Needs app
     * 0.12.0.
     *
     * @example
     * zk.ui.image({ src: "images/logo.png", width: "40%" });
     */
    function image(image: { src: string; width?: Width; id?: string }): ImageBlock;

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
     * does nothing when no screen of the plugin is showing. Outside what the user does (a timer,
     * the background task), refreshes are merged into at most one render a second; one from a
     * user-caused call (an action, a handler of what the user did) renders at once.
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
      | ItemsBlock
      | ListBlock
      | SearchBlock
      | FieldBlock
      | ChipsBlock
      | ButtonBlock
      | ButtonsBlock
      | DividerBlock
      | SpaceBlock
      | NoticeBlock
      | QuoteBlock
      | SpacerBlock
      | BoxBlock
      | CoverBlock
      | ProgressBlock
      | ItemBlock
      | GridBlock
      | ImageBlock;

    /** A child of a layout block, or a falsy value to skip (so `cond && block` works). */
    type Child = Block | Falsy;

    /** What a list of children skips. */
    type Falsy = null | undefined | false | "" | 0;

    /** Spacing between children. */
    type Gap = "none" | "xsmall" | "small" | "medium" | "large";

    /** A whole percentage from `"1%"` to `"100%"`. */
    type Percent = `${number}%`;

    /**
     * How wide a block is, for any block (it matters in a {@link row}, and for a cover, a
     * progress bar or an image anywhere): `"fill"` shares what the siblings leave, `"auto"` is
     * its natural width (a text's, a button's), `"<n>%"` is that share of the row's width.
     * However long an `"auto"` sibling, a `"fill"` keeps at least 120 px (or an equal share of a
     * narrow row) and a percent as much of that as it asks for: the long text wraps instead.
     * Needs app 0.12.0.
     */
    type Width = "fill" | "auto" | Percent;

    /** Where a row's children sit vertically; `"stretch"` makes each as tall as the row. */
    type RowAlign = "top" | "center" | "bottom" | "stretch";

    /** A {@link box}'s border: none, a hairline or a heavy line. */
    type Border = "none" | "thin" | "thick";

    /** A {@link box}'s fill: none, a light grey, or ink (text inside is white). */
    type Fill = "none" | "light" | "ink";

    /** A {@link box}'s corners. */
    type Radius = "none" | "small" | "round";

    /** Options of {@link text}. Needs app 0.12.0 except `style` and `lines`. */
    interface TextOptions {
      /** A preset of font, size, weight and tone; the options below override it. Default `"body"`. */
      style?: TextStyle;
      /** At most this many lines, ending with "…". */
      lines?: number;
      font?: "serif" | "sans";
      size?: "xsmall" | "small" | "body" | "large" | "title";
      weight?: "regular" | "medium" | "bold";
      /** `"inverse"` is white. Unset inside an `"ink"` box: white; elsewhere the style's. */
      tone?: "ink" | "secondary" | "inverse";
      italic?: boolean;
      /** Uppercase and spaced out: a section label. */
      caps?: boolean;
      /** Where its lines sit in its width. Default `"start"`. */
      align?: "start" | "center" | "end";
      /** Makes it tappable (a link): a tap sends a `tap` event with this id. */
      id?: string;
      /** Typeset inline (`$…$`, `\(…\)`) and display (`$$…$$`, `\[…\]`) LaTeX math on-device via MicroTeX. */
      math?: boolean;
      width?: Width;
    }

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
      /**
       * Only on the root of a Home body (a screen, or a column inside, refuses it). `"page"`
       * (default): what doesn't fit is paged. `"trim"`: the children in order while they fit;
       * the first that doesn't is trimmed if it can be (a grid to the rows that fit, a column to
       * its children that fit, recursively) and dropped otherwise; everything after it is
       * dropped; never a pager. Needs app 0.12.0.
       */
      fit?: "page" | "trim";
      width?: Width;
    }

    /** See {@link row}. */
    interface RowBlock {
      kind: "row";
      /** At most 12 (6 before app 0.12.0). */
      children: Child[];
      /** Default `"small"`. */
      gap?: Gap;
      /** Default `"center"` (as rows were before 0.12). Needs app 0.12.0. */
      align?: RowAlign;
      width?: Width;
    }

    /** See {@link text}. */
    interface TextBlock extends TextOptions {
      kind: "text";
      text: string | Span[];
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
      /** Typeset inline (`$…$`, `\(…\)`) and display (`$$…$$`, `\[…\]`) LaTeX math in title and body via MicroTeX. */
      math?: boolean;
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

    /** An item for an {@link items} block: its key, or the key with its library and a label. */
    type ItemRef = string | {
      key: string;
      /** 0 My Library, else a group's id ({@link zk.library.libraries}). Omitted: the app finds the item by its key across the libraries it shows. */
      library?: number;
      /** The kicker line above a `card`'s title (e.g. "BOOK · CONTINUE"); a `row` ignores it. */
      label?: string;
    };

    /** See {@link items}. */
    interface ItemsBlock {
      kind: "items";
      id: string;
      /**
       * `"card"`: a large entry per item; `"row"`: a compact line per item; `"shelf"`: cover tiles
       * in rows.
       *
       * A shelf's tile is the item's cover as the app draws it (a book in one of three
       * looks chosen by its key; a paper like a first page; no corner tab; from app 0.12.0), a thin progress bar
       * once it was opened, and one line under it: "13%", "New" or "Read", or the download's
       * progress while it downloads. The tiles per row follow the screen's width (4 on a
       * Paperwhite or a Kindle, 6 on a Scribe), and the shelf pages a row at a time. A ref's
       * `label` isn't shown on a shelf. `"shelf"` needs app 0.11.0 (older apps refuse the tree).
       *
       * @example
       * zk.ui.items({ id: "shelf", style: "shelf", items: keys });
       */
      style: "card" | "row" | "shelf";
      items: ItemRef[];
      /** Shown when none of the items can be read. */
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
      /** Makes it tappable: a tap sends a `tap` event with this id. Needs app 0.9.0. */
      id?: string;
    }

    /** See {@link quote}. Needs app 0.11.0. */
    interface QuoteBlock {
      kind: "quote";
      /** The passage: at most 5 lines show. */
      text: string;
      /** Where it is from, on one line under it (`"Pride and Prejudice · p. 1"`). */
      source?: string;
      /** Makes it tappable: a tap sends a `tap` event with this id. */
      id?: string;
    }

    /** See {@link spacer}. Needs app 0.12.0. */
    interface SpacerBlock {
      kind: "spacer";
      width?: Width;
    }

    /** See {@link box}. Needs app 0.12.0. */
    interface BoxBlock {
      kind: "box";
      child: Block;
      /** Makes it tappable: a tap sends a `tap` event with this id. */
      id?: string;
      /** Space between the frame and the child. Default `"none"`. */
      pad?: Gap;
      /** Default `"none"`. */
      border?: Border;
      /** Default `"none"`. */
      fill?: Fill;
      /** Default `"none"`. */
      radius?: Radius;
      width?: Width;
    }

    /** See {@link cover}. Needs app 0.12.0. */
    interface CoverBlock {
      kind: "cover";
      item: ItemRef;
      /** Default `"fill"`. */
      width?: Width;
    }

    /** See {@link progress}. Needs app 0.12.0. */
    interface ProgressBlock {
      kind: "progress";
      /** From 0 to 1. */
      value: number;
      width?: Width;
    }

    /** See {@link item}. Needs app 0.12.0. */
    interface ItemBlock {
      kind: "item";
      item: ItemRef;
      child: Block;
      width?: Width;
    }

    /** See {@link grid}. Needs app 0.12.0. */
    interface GridBlock {
      kind: "grid";
      children: Child[];
      /** 1 to 12, or `"auto"` (default). */
      columns?: number | "auto";
      /** With `"auto"` columns, the narrowest a cell gets: `"5%"` to `"100%"`, default `"25%"`. */
      minWidth?: Percent;
      /** Default `"small"`. */
      gap?: Gap;
      /** 1 to 20: draw only this many rows, never page. */
      rows?: number;
      width?: Width;
    }

    /** See {@link image}. Needs app 0.12.0. */
    interface ImageBlock {
      kind: "image";
      /** A path in the plugin's package: not absolute, no `..`. */
      src: string;
      width?: Width;
      /** Makes it tappable: a tap sends a `tap` event with this id. */
      id?: string;
    }

    /**
     * What `onEvent` receives. Events arrive one at a time, in the order they happened; a
     * pending `change` (typing not yet sent) is always sent before any other event of the same
     * screen, so a tap on "File" sees the note just typed.
     *
     * - `open` — the screen is opening; first, before its first render ("Loading…" shows until
     *   it returns). For set-up slower than `render`'s 1 s.
     * - `tap` — a {@link button}, or one of {@link buttons}, by its `id`; the {@link deck}'s card,
     *   by the deck's `id`; a {@link notice} with an `id` (the last two need app 0.9.0); a
     *   {@link quote} with an `id` (app 0.11.0); a {@link box}, an {@link image} or a {@link text} with an `id` (app 0.12.0).
     * - `select` — a {@link list} row: `id` is the list's, `row` the row's.
     * - `swipe` — the {@link deck}'s card, left or right.
     * - `change` / `submit` — a {@link search} or {@link field}: its whole text.
     * - `chips` — a chip tapped: which one, and the selection it makes (keep it and render it as
     *   `selected`, or the chips go back as they were).
     * - `result` — a screen this one opened has closed: its id and what {@link close} gave
     *   (`undefined` if closed with Back or without a result).
     * - `back` — the user left this screen. It is already closed; nothing is rendered after.
     * - `reader` — a preview this screen opened with {@link zk.reader.open} closed (`closed:
     *   true`): the screen shows again as it was. Needs app 0.9.0. Also sent (app 0.10.0) when an
     *   item opened from an {@link items} block or with {@link zk.library.open} closes.
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
      | { kind: "back" }
      | {
          kind: "reader";
          closed: true;
          /** Present when `zk.reader.open` was called with `save: true` or `save: "prompt"`. */
          action?: "save" | "discard" | "close";
          /** Temporary highlights/underlines made during a saveable preview (non-empty when annotated). */
          annotations?: zk.reader.PreviewAnnotation[];
        };
  }

  // ───────────────────────────── The reader ─────────────────────────────

  /**
   * The app's reader, for documents that aren't in the library. Needs app 0.9.0.
   */
  namespace reader {
    /** A temporary highlight or underline made while reading a preview opened with `save`. */
    interface PreviewAnnotation {
      type: "highlight" | "underline";
      text: string;
      comment?: string;
      color: string;
      pageLabel?: string;
      tags?: string[];
    }

    /**
     * Opens a document in the app's reader as a **preview**: nothing is added to the library.
     *
     * - `url`: a PDF or EPUB to download (https only, and the plugin needs `net` permission for
     *   its host, as for {@link zk.fetch}). The type comes from the response's Content-Type, then
     *   from the file's first bytes; a page that turns out to be HTML opens as `html`. A download
     *   screen shows the progress with **Cancel**. At most 50 MB.
     * - `html`: a page the plugin already has (an article it extracted), opened like a saved web
     *   page. No scripts run; images aren't fetched (`data:` URLs show). `baseUrl` resolves its
     *   relative links.
     * - `save`: `true` enables temporary highlighting/notes in Preview, adds a **Save** button to
     *   the reader menu, and asks *Save or Discard?* on Back when annotations exist; `"prompt"`
     *   always asks *Save or Discard?* on Back. The screen's `reader` close event then carries
     *   `action` (`"save" | "discard" | "close"`) and `annotations`.
     *
     * Without `save`, there is no highlighting, notes or bookmarks: a selection offers Search and
     * plugin actions (their {@link TextSelection} has `item: null` and `preview`). The top bar says
     * "Preview". Nothing syncs. The app keeps the last 10 previewed documents (at most 100 MB) with
     * their reading places, so opening one again is instant.
     *
     * Only in answer to the user (a screen's `onEvent`, an action's `run`), like {@link zk.ui.open};
     * elsewhere, or with a URL that isn't https or whose host isn't declared, it throws. The
     * promise resolves when the reader shows, and rejects if the download fails or the user
     * cancels it; waiting doesn't count against the call's time. Back returns to the screen as it
     * was, and the screen gets a `{ kind: "reader", closed: true }` event.
     *
     * @example
     * if (e.kind === "tap" && e.id === "card") await zk.reader.open({ url: `https://arxiv.org/pdf/${card.arxiv}`, title: card.title, save: "prompt" });
     * @example
     * await zk.reader.open({ html: article, title: card.title, baseUrl: card.link, save: true });
     */
    function open(
      doc:
        | { url: string; title?: string; save?: boolean | "prompt" }
        | { html: string; title: string; baseUrl?: string; save?: boolean | "prompt" },
    ): Promise<void>;
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
    /**
     * How far the item was read on this Kindle (its current place in the attachment), 0…1;
     * `null` if it was never opened here. Not synced, and not the read mark (`read`). Needs app
     * 0.10.0.
     */
    progress: number | null;
    /** When the user last opened it on this Kindle (ISO 8601), `null` if never. Needs app 0.10.0. */
    openedAt: string | null;
    /** When it was added to Zotero (its `dateAdded`, ISO 8601). Needs app 0.10.0. */
    addedAt: string;
    /** The format of the attachment the app opens: `null` if it has none it can read. Needs app 0.10.0. */
    format: "EPUB" | "PDF" | "WEB" | null;
    /** Zotero's *Extra* field. */
    extra: string | null;
    /**
     * The citation key: Zotero's own `citationKey` field when it has one, else the
     * `Citation Key:` line Better BibTeX writes into *Extra*.
     */
    citationKey: string | null;
    /** Its library: 0 My Library, else the Zotero group's id. Needs app 0.8.0. */
    libraryId: number;
    /** Its library's name: `"My Library"` or the group's name. Needs app 0.8.0. */
    libraryName: string;
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
    /** Its library: 0 My Library, else the Zotero group's id. Needs app 0.8.0. */
    libraryId: number;
    /** Its library's name: `"My Library"` or the group's name. Needs app 0.8.0. */
    libraryName: string;
  }

  /** A library on the Kindle: My Library or a Zotero group library ({@link zk.library.libraries}). */
  interface LibraryInfo {
    /** 0 for My Library, else the Zotero group's id. */
    id: number;
    /** `"My Library"`, or the group's name. */
    name: string;
    /** Whether changes there can go to Zotero (My Library always; a group when the user may edit it). */
    editable: boolean;
    /** How many top-level items it has on the Kindle. */
    items: number;
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
    /** Its library: 0 My Library, else the Zotero group's id. Needs app 0.8.0. */
    libraryId: number;
    /** Its library's name: `"My Library"` or the group's name. Needs app 0.8.0. */
    libraryName: string;
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
     * Which limit: run time, memory, stack depth, a fetch's response size or duration, too many
     * fetches under way at once, too many timers pending ({@link setTimeout}), or too many handlers
     * for one event ({@link on}).
     */
    readonly limit: "time" | "memory" | "stack" | "responseSize" | "responseTime" | "fetches" | "timers" | "handlers";
  }
}
