import { lookup } from "node:dns/promises";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { CapabilityAnnotation, messageOf } from "@magentic/plugin";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { EMPTY, OUTPUT_LIMIT, push, render, ToolOutputDir, whole } from "./ToolOutput.ts";

/**
 * Returned to the model as a tool result rather than failing the run, so the
 * agent can react (narrow the page, ask for another URL, report the problem).
 */
export class HttpFetchError extends Schema.TaggedError<HttpFetchError>()("HttpFetchError", {
  reason: Schema.Literals(["InvalidUrl", "Blocked", "TooLarge", "Timeout", "HttpError"]),
  url: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}

/** Bytes of response body read at most; anything heavier is a bundle, not a page. */
export const FETCH_WIRE_CAP = 5 * 1_048_576;
/** Redirects followed per call; every hop is checked the way the first URL was. */
export const FETCH_MAX_REDIRECTS = 5;
/** How long a fetch may take when the call does not say. */
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest a call may ask for. */
export const FETCH_MAX_TIMEOUT_MS = 120_000;
/** Characters of an error response's body the model gets to see; APIs explain themselves there. */
const ERROR_SNIPPET_LIMIT = 2_000;
/** Bytes of an error body read for that snippet. */
const ERROR_SNIPPET_WIRE_CAP = 65_536;

/** What the tool is, for hosts that want to know; used when the browser string is challenged. */
const HONEST_USER_AGENT = "magentic-http-fetch/1.0";
/**
 * What most pages get. Many sites answer a plain product string with a 403
 * or an empty shell; a browser string gets the same page a person would.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const Format = Schema.Literals(["markdown", "text", "html"]);
type Format = typeof Format.Type;

const FetchResult = Schema.Struct({
  /** The URL the content came from, after redirects. */
  url: Schema.String,
  status: Schema.Int,
  contentType: Schema.optional(Schema.String),
  content: Schema.String,
  /** Present, and true, only when the content is not the whole body. */
  truncated: Schema.optional(Schema.Boolean),
  /** Where the whole body is, outside the workspace; present only when truncated. */
  contentFile: Schema.optional(Schema.String),
});

/** The schema's type with its fields writable, so a result can be built up in steps. */
type FetchResult = { -readonly [K in keyof typeof FetchResult.Type]: (typeof FetchResult.Type)[K] };

export const HttpFetch = Tool.make("http_fetch", {
  description:
    "Fetch a page over HTTPS and get back its content as text. " +
    "Use it to read documentation, references, and articles the workspace does not have. " +
    "HTML comes back as markdown of the page's main content, the way a reader view shows it; " +
    "JSON and other text comes back as is. No JavaScript runs, so pages built in the browser come back empty. " +
    `Content past ${OUTPUT_LIMIT} characters is cut in the middle and marked truncated; ` +
    "the whole is saved to contentFile, outside the workspace. " +
    "Plain http URLs are fetched over https instead. Credentials in the URL, and hosts that " +
    "resolve to loopback, private, link-local, or otherwise non-public addresses, are refused.",
  parameters: Schema.Struct({
    url: Schema.NonEmptyString.annotate({ description: "The URL to fetch" }),
    format: Schema.optionalKey(
      Format.annotate({
        description:
          "How to return HTML: the main content as markdown (markdown, the default), the whole page as plain text (text, when reader mode dropped something you need), or the raw markup (html); other content comes back as is",
      }),
    ),
    timeout: Schema.optionalKey(
      Schema.Int.annotate({
        description: `Milliseconds before the fetch is abandoned; default ${FETCH_DEFAULT_TIMEOUT_MS}, at most ${FETCH_MAX_TIMEOUT_MS}`,
      }),
    ),
  }),
  success: FetchResult,
  failure: HttpFetchError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "http:egress");

export const HttpFetchTools = Toolkit.make(HttpFetch);

const clampTimeout = (requested: number | undefined): number =>
  requested === undefined || requested <= 0
    ? FETCH_DEFAULT_TIMEOUT_MS
    : Math.min(requested, FETCH_MAX_TIMEOUT_MS);

/** Whether a resolved address is not the public internet: transports, not names, are trusted. */
const isBlockedAddress = (address: string): boolean => {
  const host = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (host === undefined || host === "") {
    return true;
  }
  // An IPv4-mapped IPv6 address is the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)?.[1];
  const v4 = mapped ?? host;
  if (!v4.includes(":")) {
    const parts = v4.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) {
      return true;
    }
    const [a = 0, b = 0] = parts.map(Number);
    return (
      a === 0 || // This network.
      a === 10 || // Private.
      a === 127 || // Loopback.
      (a === 169 && b === 254) || // Link-local, and the cloud metadata services on it.
      (a === 172 && b >= 16 && b <= 31) || // Private.
      (a === 192 && b === 168) || // Private.
      (a === 100 && b >= 64 && b <= 127) || // Shared address space.
      (a === 198 && (b === 18 || b === 19)) || // Benchmarking.
      a >= 224 // Multicast and reserved.
    );
  }
  const lower = host.toLowerCase();
  return (
    lower === "::1" || // Loopback.
    lower === "::" || // Unspecified.
    lower.startsWith("fe80:") || // Link-local.
    lower.startsWith("fc") || // Unique-local.
    lower.startsWith("fd") // Unique-local.
  );
};

/** Content the tool hands the model as text; anything else is a download, not a page. */
const isTextual = (contentType: string): boolean =>
  contentType.startsWith("text/") ||
  contentType === "application/json" ||
  contentType === "application/xml" ||
  contentType === "application/javascript" ||
  contentType === "application/x-javascript" ||
  contentType === "application/yaml" ||
  contentType.endsWith("+json") ||
  contentType.endsWith("+xml") ||
  contentType.endsWith("+text");

const isHtml = (contentType: string | undefined): boolean =>
  contentType === "text/html" || contentType === "application/xhtml+xml";

/** The media type of a response, lowercased and without parameters; undefined when it has none. */
const contentTypeOf = (headers: Headers.Headers): string | undefined => {
  const raw = Option.getOrUndefined(Headers.get(headers, "content-type")) ?? "";
  return raw.split(";")[0]?.trim().toLowerCase() || undefined;
};

const charsetOf = (headers: Headers.Headers): string => {
  const raw = Option.getOrUndefined(Headers.get(headers, "content-type")) ?? "";
  const found = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(raw)?.[1];
  return found === undefined ? "utf-8" : found.trim();
};

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
]);

const decodeEntities = (text: string): string =>
  text
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => {
      const point = Number.parseInt(hex, 16);
      return Number.isSafeInteger(point) && point <= 0x10_ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&#(\d+);/g, (match, digits: string) => {
      const point = Number.parseInt(digits, 10);
      return Number.isSafeInteger(point) && point <= 0x10_ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES.get(name) ?? match);

/** HTML to plain text without a parser: structure becomes line breaks, the rest is dropped. */
const htmlToText = (html: string): string => {
  const withoutScripts = html.replace(
    /<(script|style|noscript|template|svg|canvas)[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "\n",
  );
  const blocked = withoutScripts.replace(
    /<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|table|tr|br|hr|title)[^>]*>/gi,
    "\n",
  );
  const untagged = blocked.replace(/<[^>]*>/g, "");
  const lines = decodeEntities(untagged)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim());
  const kept: Array<string> = [];
  for (const line of lines) {
    if (line !== "" || kept[kept.length - 1] !== "") {
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
};

/** Elements that are never the page's content: code, styling, and things drawn rather than read. */
const NOT_CONTENT: Array<TurndownService.TagName> = [
  "script",
  "style",
  "noscript",
  "template",
  "meta",
  "link",
  "iframe",
  "canvas",
  "nav",
  "aside",
  "footer",
];

const markdownService = (): TurndownService =>
  new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

const markdownOf = (html: string, turndown: TurndownService): string =>
  turndown
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The whole page as markdown with the chrome cut away by name: navigation,
 * sidebars, footers, and the header at the top of the body. Headers inside
 * an article stay, since that is where its title is.
 */
const wholePageMarkdown = (html: string): string => {
  const turndown = markdownService();
  turndown.remove(NOT_CONTENT);
  turndown.remove(
    (node) =>
      node.nodeName === "svg" ||
      (node.nodeName === "HEADER" && node.parentNode?.nodeName === "BODY") ||
      node.getAttribute("role") === "navigation" ||
      node.getAttribute("role") === "search" ||
      node.getAttribute("aria-hidden") === "true",
  );
  return markdownOf(html, turndown);
};

/**
 * The page as a reader view shows it: Readability picks the article out of
 * the chrome and turndown makes markdown of it. A page it cannot read as an
 * article, such as an index or a landing page, comes back whole instead.
 */
const readerMarkdown = (html: string, url: string): string => {
  const { document } = parseHTML(html);
  // Readability resolves the article's links against the document's base,
  // which a parsed string does not have; the page's own address is it.
  if (document.querySelector("base[href]") === null) {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head.prepend(base);
  }
  const article = new Readability(document).parse();
  const content = article?.content ?? "";
  if (content.trim() === "") {
    return wholePageMarkdown(html);
  }
  const body = markdownOf(content, markdownService());
  // Readability keeps the title apart from the content; the model wants both.
  const title = article?.title?.trim() ?? "";
  return title === "" || body.startsWith(`# ${title}`) ? body : `# ${title}\n\n${body}`;
};

const convert = (
  decoded: string,
  contentType: string | undefined,
  format: Format,
  url: string,
): string => {
  if (!isHtml(contentType) || format === "html") {
    return decoded;
  }
  return format === "text" ? htmlToText(decoded) : readerMarkdown(decoded, url);
};

const decodeBytes = (bytes: Uint8Array, charset: string): string => {
  try {
    // SAFETY: TextDecoder accepts any IANA label at runtime and throws for an
    // unknown one, which the catch below turns into utf-8; the assertion is only
    // because the type lists a fixed set of labels.
    return new TextDecoder(charset as "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

interface Collected {
  readonly chunks: Array<Uint8Array>;
  readonly size: number;
}

const NOTHING_COLLECTED: Collected = { chunks: [], size: 0 };

const joined = (collected: Collected): Uint8Array => {
  const bytes = new Uint8Array(collected.size);
  let at = 0;
  for (const chunk of collected.chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

/** Reads a body up to `cap` bytes; what comes after is dropped rather than refused. */
const collectPrefix = (response: HttpClientResponse.HttpClientResponse, cap: number) =>
  response.stream.pipe(
    Stream.runFold(
      (): Collected => NOTHING_COLLECTED,
      (acc, chunk) =>
        acc.size >= cap
          ? acc
          : {
              chunks: [...acc.chunks, chunk.subarray(0, cap - acc.size)],
              size: Math.min(cap, acc.size + chunk.byteLength),
            },
    ),
    Effect.map(joined),
  );

const redirectOf = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/** Handlers for the fetch tool. Needs an HttpClient, a FileSystem, a Path, and a ToolOutputDir. */
export const httpFetchHandlers = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputDir = yield* ToolOutputDir;

  const blocked = (url: string, message: string) =>
    new HttpFetchError({ reason: "Blocked", url, message });

  /**
   * What the tool refuses whatever hop it is on: a scheme it does not speak,
   * and credentials. A redirect is checked the same way the first URL was,
   * or a `Location: file:///etc/passwd` would be fetched as readily as a
   * page, and a redirect to `http://` would put the rest on the wire in the
   * clear.
   */
  const vetUrl = Effect.fn("HttpFetch.vetUrl")(function* (parsed: URL, raw: string) {
    if (parsed.protocol === "http:") {
      // Old links say http; the site has long since moved. Fetching it as
      // https keeps the transport one that cannot be read on the way.
      parsed.protocol = "https:";
    }
    if (parsed.protocol !== "https:") {
      return yield* new HttpFetchError({
        reason: "InvalidUrl",
        url: raw,
        message: `only https URLs are fetched; ${parsed.protocol}// is refused`,
      });
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return yield* new HttpFetchError({
        reason: "InvalidUrl",
        url: raw,
        message: "URLs with credentials are refused; they would leak into the transcript",
      });
    }
    return parsed;
  });

  /** Parse the model's URL and refuse what is not fetchable before touching the network. */
  const parseUrl = Effect.fn("HttpFetch.parseUrl")(function* (raw: string) {
    const parsed = yield* Effect.try({
      try: () => new URL(raw),
      catch: () =>
        new HttpFetchError({
          reason: "InvalidUrl",
          url: raw,
          message: `${raw} is not a URL the tool fetches; give an absolute https URL`,
        }),
    });
    return yield* vetUrl(parsed, raw);
  });

  /** Resolve the host and refuse it when any address is not the public internet. */
  const checkUrl = Effect.fn("HttpFetch.checkUrl")(function* (parsed: URL, raw: string) {
    const addresses = yield* Effect.tryPromise({
      try: () => lookup(parsed.hostname, { all: true }),
      catch: (error) =>
        new HttpFetchError({
          reason: "HttpError",
          url: raw,
          message: `${parsed.hostname} does not resolve: ${messageOf(error)}`,
        }),
    });
    // A host that resolves to nothing has no address to judge, and `find`
    // over an empty list judges nothing: refuse it rather than let it past.
    if (addresses.length === 0) {
      return yield* blocked(
        raw,
        `${parsed.hostname} resolves to no address; only the public internet is fetched`,
      );
    }
    const bad = addresses.find((entry) => isBlockedAddress(entry.address));
    if (bad !== undefined) {
      return yield* blocked(
        raw,
        `${parsed.hostname} resolves to ${bad.address}, which is not public; only the public internet is fetched`,
      );
    }
    return parsed;
  });

  // The fetch client follows redirects on its own; manual mode keeps every hop
  // visible, so each one is checked before it is followed.
  const send = (target: URL, raw: string, userAgent: string) => {
    const request = HttpClientRequest.get(target.href).pipe(
      HttpClientRequest.setHeader("user-agent", userAgent),
      HttpClientRequest.setHeader(
        "accept",
        "text/html,application/xhtml+xml,application/json,text/*;q=0.9,*/*;q=0.5",
      ),
      HttpClientRequest.setHeader("accept-language", "en-US,en;q=0.9"),
    );
    return client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError(
        (error) =>
          new HttpFetchError({
            reason: "HttpError",
            url: raw,
            message: `requesting ${target.href} failed: ${messageOf(error)}`,
          }),
      ),
    );
  };

  /** Fetch as a browser would; when Cloudflare challenges that, say who we are and try once more. */
  const execute = Effect.fn("HttpFetch.execute")(function* (target: URL, raw: string) {
    const response = yield* send(target, raw, BROWSER_USER_AGENT);
    const challenged =
      response.status === 403 &&
      Option.getOrUndefined(Headers.get(response.headers, "cf-mitigated")) === "challenge";
    return challenged ? yield* send(target, raw, HONEST_USER_AGENT) : response;
  });

  /** The start of an error response's body, as text, so the model sees what the server said. */
  const errorSnippet = Effect.fn("HttpFetch.errorSnippet")(function* (
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const contentType = contentTypeOf(response.headers);
    if (contentType !== undefined && !isTextual(contentType)) {
      return "";
    }
    const bytes = yield* collectPrefix(response, ERROR_SNIPPET_WIRE_CAP).pipe(
      Effect.orElseSucceed(() => new Uint8Array()),
    );
    const text = convert(decodeBytes(bytes, charsetOf(response.headers)), contentType, "text", "")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > ERROR_SNIPPET_LIMIT ? `${text.slice(0, ERROR_SNIPPET_LIMIT)}…` : text;
  });

  const readBody = Effect.fn("HttpFetch.readBody")(function* (
    response: HttpClientResponse.HttpClientResponse,
    raw: string,
    finalUrl: string,
    format: Format,
  ) {
    const contentType = contentTypeOf(response.headers);
    if (contentType !== undefined && !isTextual(contentType)) {
      return yield* new HttpFetchError({
        reason: "HttpError",
        url: raw,
        status: response.status,
        message:
          `${finalUrl} is ${contentType}, which http_fetch does not read; ` +
          "only HTML, JSON, XML, and text come back",
      });
    }
    const collected = yield* response.stream.pipe(
      Stream.runFoldEffect(
        (): Collected => NOTHING_COLLECTED,
        (acc, chunk) =>
          acc.size + chunk.byteLength > FETCH_WIRE_CAP
            ? Effect.fail(
                new HttpFetchError({
                  reason: "TooLarge",
                  url: raw,
                  message:
                    `${finalUrl} is over the ${FETCH_WIRE_CAP} byte cap; ` +
                    "fetch a smaller page instead",
                }),
              )
            : Effect.succeed({
                chunks: [...acc.chunks, chunk],
                size: acc.size + chunk.byteLength,
              }),
      ),
      Effect.mapError((error) =>
        error instanceof HttpFetchError
          ? error
          : new HttpFetchError({
              reason: "HttpError",
              url: raw,
              status: response.status,
              message: `reading ${finalUrl} failed: ${messageOf(error)}`,
            }),
      ),
    );
    const decoded = decodeBytes(joined(collected), charsetOf(response.headers));
    const text = convert(decoded, contentType, format, finalUrl);
    const buffer = push(EMPTY, text);
    const result: FetchResult = { url: finalUrl, status: response.status, content: text };
    if (contentType !== undefined) {
      result.contentType = contentType;
    }
    if (whole(buffer)) {
      return result;
    }
    // Past the inline limit the whole body goes to a file, the way the shell
    // keeps long output: the model reads the part it wants from there.
    const file = path.join(outputDir, `http-fetch-${crypto.randomUUID()}.txt`);
    const savedAs = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(outputDir, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(file, text, { mode: 0o600 });
      return file;
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(`http_fetch: body of ${finalUrl} not saved to ${file}`, cause),
      ),
      Effect.option,
    );
    result.content = render(buffer, Option.getOrUndefined(savedAs)).text;
    result.truncated = true;
    if (Option.isSome(savedAs)) {
      result.contentFile = savedAs.value;
    }
    return result;
  });

  const fetchUrl = Effect.fn("HttpFetch.fetch")(function* (raw: string, format: Format) {
    let current = yield* checkUrl(yield* parseUrl(raw), raw);
    for (let redirects = 0; ; redirects += 1) {
      const response = yield* execute(current, raw);
      if (!redirectOf(response.status)) {
        if (response.status < 200 || response.status >= 300) {
          const said = yield* errorSnippet(response);
          return yield* new HttpFetchError({
            reason: "HttpError",
            url: raw,
            status: response.status,
            message:
              `fetching ${current.href} failed with status ${response.status}` +
              (said === "" ? "" : `; the response said: ${said}`),
          });
        }
        return yield* readBody(response, raw, current.href, format);
      }
      if (redirects >= FETCH_MAX_REDIRECTS) {
        return yield* new HttpFetchError({
          reason: "HttpError",
          url: raw,
          status: response.status,
          message: `fetching ${raw} redirected more than ${FETCH_MAX_REDIRECTS} times`,
        });
      }
      const location = Option.getOrUndefined(Headers.get(response.headers, "location"));
      if (location === undefined) {
        return yield* new HttpFetchError({
          reason: "HttpError",
          url: raw,
          status: response.status,
          message: `fetching ${current.href} redirected without a location`,
        });
      }
      const next = yield* Effect.try({
        try: () => new URL(location, current.href),
        catch: () =>
          new HttpFetchError({
            reason: "HttpError",
            url: raw,
            status: response.status,
            message: `fetching ${current.href} redirected to ${JSON.stringify(location)}, which is not a URL`,
          }),
      });
      current = yield* checkUrl(yield* vetUrl(next, raw), raw);
    }
  });

  return HttpFetchTools.of({
    http_fetch: Effect.fn("HttpFetch.http_fetch")(function* ({ url, format, timeout }) {
      const limit = clampTimeout(timeout);
      const done = yield* fetchUrl(url, format ?? "markdown").pipe(Effect.timeoutOption(limit));
      if (Option.isNone(done)) {
        return yield* new HttpFetchError({
          reason: "Timeout",
          url,
          message: `fetching ${url} took longer than ${limit} ms`,
        });
      }
      return done.value;
    }),
  });
});

export const HttpFetchToolsLayer = HttpFetchTools.toLayer(httpFetchHandlers);
