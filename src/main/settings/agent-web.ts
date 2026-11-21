import { isIP } from "node:net";
import { Parser } from "htmlparser2";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { endpointURL, openProviderResponse } from "./network.ts";

function unavailable(): never {
  throw new ProviderError("AGENT_WEB_UNAVAILABLE");
}

function publicPage(value: string) {
  const url = endpointURL(value, false);
  if (url.port || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes("."))
    return unavailable();
  return url;
}

function pageText(html: string) {
  const hiddenTags = new Set(["script", "style", "noscript", "template", "svg", "head"]);
  const blocks = new Set(["p", "li", "div", "br", "h1", "h2", "h3", "section", "article"]);
  let hidden = 0;
  const chunks: string[] = [];
  new Parser({
    onopentag(name) {
      if (hiddenTags.has(name)) hidden++;
      if (!hidden && blocks.has(name)) chunks.push("\n");
    },
    onclosetag(name) {
      if (hiddenTags.has(name)) hidden--;
      if (!hidden && blocks.has(name)) chunks.push("\n");
    },
    ontext(text) {
      if (!hidden) chunks.push(text);
    },
  }).end(html);
  return chunks
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

async function readPublic(url: URL, mimes: string[]) {
  const response = await openProviderResponse(url.origin, false, {
    method: "GET",
    url: url.href,
    headers: {
      accept: mimes.join(", "),
      "user-agent": "Link Studio/0.1 (public creative research)",
    },
    timeoutMs: 6000,
    responseType: "text",
  });
  const mime = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (response.statusCode !== 200 || !mime || !mimes.includes(mime)) {
    response.destroy();
    return unavailable();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 512 * 1024) return unavailable();
    chunks.push(chunk);
  }
  return { mime, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
}

export async function queryAgentWeb(name: string, args: unknown, redact: (text: string) => string) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return unavailable();
  if (name === "web_fetch") {
    if (
      !("url" in args) ||
      typeof args.url !== "string" ||
      args.url.length > 2048 ||
      redact(decodeURIComponent(args.url)) !== decodeURIComponent(args.url)
    )
      return unavailable();
    const url = publicPage(args.url);
    const { mime, text } = await readPublic(url, ["text/html", "text/plain", "text/markdown"]);
    const clean = redact(mime === "text/html" ? pageText(text) : text.trim());
    if (!clean) return unavailable();
    return { url: url.href, text: clean.slice(0, 12000), truncated: clean.length > 12000 };
  }
  if (name !== "web_search" || !("query" in args) || typeof args.query !== "string")
    return unavailable();
  const query = args.query.trim();
  const limit = "limit" in args ? args.limit : 5;
  if (
    !query ||
    query.length > 300 ||
    redact(query) !== query ||
    Array.from(query).some((character) => character.charCodeAt(0) < 32) ||
    /(?:https?:\/\/|file:|(?:^|\s)[/~]|\b[A-Z]:\\)/i.test(query) ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5
  )
    return unavailable();
  const origin = /\p{Script=Han}/u.test(query)
    ? "https://zh.wikipedia.org"
    : "https://en.wikipedia.org";
  const url = new URL("/w/api.php", origin);
  url.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(limit),
    format: "json",
  }).toString();
  const { text } = await readPublic(url, ["application/json"]);
  const results: unknown = JSON.parse(text)?.query?.search;
  if (!Array.isArray(results)) return unavailable();
  return {
    source: "Wikipedia",
    results: results.slice(0, limit).flatMap((result) => {
      const title = result?.title;
      if (typeof title !== "string" || !title || title.length > 250 || redact(title) !== title)
        return [];
      return [
        {
          title,
          url: `${origin}/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
          snippet:
            typeof result.snippet === "string"
              ? redact(pageText(result.snippet)).slice(0, 400)
              : "",
        },
      ];
    }),
  };
}
