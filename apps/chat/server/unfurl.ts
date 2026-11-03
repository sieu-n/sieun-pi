/**
 * Slack-style link previews: the title, description, site name and image a web page states in its Open Graph and Twitter meta tags, read
 * from its <head>. `GET /api/unfurl?url=` answers one; the page draws it as a card under the post that links it. Slack unfurls every link
 * in a message by default (docs.slack.dev/messaging/unfurling-links-in-messages), so the page asks for each web link a post holds.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LinkPreview } from "../web/src/lib/api/types.ts";

export type { LinkPreview };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Resolve = (host: string) => Promise<string[]>;

/** The Fetch standard's redirect limit, which browsers follow too. */
const MAX_REDIRECTS = 20;

const resolveAll: Resolve = async host => (await lookup(host, { all: true })).map(a => a.address);

/** Security: a preview fetch reaches only the public internet, never this box, the tailnet or a LAN. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** The preview a page's <head> states, or null when it states no title. */
export function readHead(html: string, pageUrl: string): LinkPreview | null {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find(v => v !== undefined);
    const key = (attr("property") ?? attr("name"))?.toLowerCase();
    const content = attr("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decode(content));
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = meta.get("og:title") || meta.get("twitter:title") || (titleTag ? decode(titleTag) : "");
  if (!title) return null;
  const description = meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || "";
  let image: string | undefined;
  const rawImage = meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image") || meta.get("twitter:image:src");
  if (rawImage) {
    try {
      const resolved = new URL(rawImage, pageUrl);
      if (resolved.protocol === "https:") image = resolved.href;
    } catch {
      image = undefined;
    }
  }
  const site = meta.get("og:site_name") || new URL(pageUrl).hostname.replace(/^www\./, "");
  return { url: pageUrl, site, title, ...(description ? { description } : {}), ...(image ? { image } : {}) };
}

export class Unfurler {
  /** One read per link while the server runs; a failed read is dropped, so the next view tries again. */
  private readonly cache = new Map<string, Promise<LinkPreview | null>>();

  constructor(private readonly fetcher: Fetch = fetch, private readonly resolve: Resolve = resolveAll) {}

  get(url: string): Promise<LinkPreview | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`A link preview needs a web URL; ${url} is not one.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`A link preview needs an http or https URL; ${url} is not one.`);
    parsed.hash = "";
    const key = parsed.href;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.read(key).catch(() => {
        this.cache.delete(key);
        return null;
      });
      this.cache.set(key, hit);
    }
    return hit;
  }

  private async read(start: string): Promise<LinkPreview | null> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host) ? [host] : await this.resolve(host);
      if (!addresses.length || addresses.some(isPrivateAddress)) return null;
      const response = await this.fetcher(url, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (compatible; sw-factory-link-preview/1.0)", accept: "text/html,application/xhtml+xml" },
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        await response.body?.cancel();
        if (!next) return null;
        url = new URL(next, url).href;
        if (!/^https?:$/.test(new URL(url).protocol)) return null;
        continue;
      }
      if (!response.ok || !/html/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        return null;
      }
      return readHead(await headOf(response), url);
    }
    return null;
  }
}

/** The page's HTML up to the end of its <head>, where the meta tags live; the rest of the page is not read. */
async function headOf(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (/<\/head>|<body\b/i.test(html)) {
      await reader.cancel();
      break;
    }
  }
  return html;
}
