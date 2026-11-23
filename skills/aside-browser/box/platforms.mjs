// Owner rule c230 (2026-11-20, "NEVER EVER FUCKING RUN WITHOUT PROXY JUST STOP FOR NOW"): no crawl or platform read leaves
// without a paid proxy. The box Chrome has no paid proxy, so it refuses every host in platform-hosts.json and its subdomains,
// at four layers: Chrome's host resolver (every request of every frame, worker and context), CDP Fetch on each page (a clear
// net::ERR_BLOCKED_BY_CLIENT), page.goto (an error naming c230), and Node's DNS lookup in the runner (fetch, http and
// Playwright's page.request). aside_browser reads the same list.
// Owner rule c230 exception (#dev-app-search-prospect p63 and p65, 11-24): Instagram image and video files load straight from its CDN.
// instagram-media-hosts.json lists those hosts as globs whose * stands for one DNS label. static.cdninstagram.com stays refused,
// because it serves the web app's script bundles the crawler reads, and Facebook's own fbcdn.net hosts stay refused.
import dns from "node:dns";
import fs from "node:fs";

const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), "utf8"));
export const PLATFORM_HOSTS = readJson("./platform-hosts.json");
export const INSTAGRAM_MEDIA_HOSTS = readJson("./instagram-media-hosts.json");
const MEDIA = INSTAGRAM_MEDIA_HOSTS.map((g) => new RegExp(`^${g.replace(/\./g, "\\.").replace(/\*/g, "[a-z0-9-]+")}$`));

export const isPlatformHost = (host) => {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return PLATFORM_HOSTS.some((p) => h === p || h.endsWith(`.${p}`)) && !MEDIA.some((m) => m.test(h));
};

export function isPlatformUrl(url) {
  try {
    return isPlatformHost(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

export const refusal = (url) => Object.assign(
  new Error(`aside-box refused ${url}: owner rule c230 allows no crawl or platform read from our servers without a paid proxy, and the box Chrome has none, so reads of ${PLATFORM_HOSTS.join(", ")} stay stopped. Only Instagram image and video files on ${INSTAGRAM_MEDIA_HOSTS.join(", ")} load, with no login and no proxy`),
  { code: "C230_REFUSED" },
);

// Chrome skips every MAP for a host an EXCLUDE matches, and its * also matches dots, so CDP Fetch and goto below check the exact hosts.
export const CHROME_ARGS = [`--host-resolver-rules=${[
  ...PLATFORM_HOSTS.flatMap((h) => [`MAP ${h} ~NOTFOUND`, `MAP *.${h} ~NOTFOUND`]),
  ...INSTAGRAM_MEDIA_HOSTS.map((g) => `EXCLUDE ${g}`),
].join(", ")}`];

const PATTERNS = PLATFORM_HOSTS.flatMap((h) => [`*://${h}*`, `*://*.${h}*`]).map((urlPattern) => ({ urlPattern, requestStage: "Request" }));
const BLOCKED = /ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL_CONNECTION_FAILED/;

/** Wraps page.goto so a platform URL throws refusal(), also when a redirect lands there, and fails every platform request of
 *  the page through CDP Fetch. Returns once Fetch is on, so a caller that awaits it before the first goto covers that load. */
export function guardPage(context, page) {
  const refused = [];
  const goto = page.goto.bind(page);
  page.goto = async (url, ...rest) => {
    if (isPlatformUrl(url)) throw refusal(url);
    const from = refused.length;
    try {
      return await goto(url, ...rest);
    } catch (e) {
      const hit = refused.slice(from)[0];
      if (hit && BLOCKED.test(String(e))) throw refusal(hit);
      throw e;
    }
  };
  return (async () => {
    const cdp = await context.newCDPSession(page);
    cdp.on("Fetch.requestPaused", ({ requestId, request, resourceType }) => {
      if (!isPlatformUrl(request.url)) return cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
      if (resourceType === "Document") refused.push(request.url);
      return cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: PATTERNS });
  })();
}

/** Makes Node's DNS lookup in this process refuse platform hosts, which covers fetch (each redirect too), http(s) and
 *  Playwright's APIRequestContext, and makes fetch throw that refusal instead of a bare "fetch failed". */
export function refuseInNode() {
  const lookup = dns.lookup;
  dns.lookup = function (host, ...rest) {
    if (!isPlatformHost(host)) return lookup.call(this, host, ...rest);
    const callback = rest[rest.length - 1];
    process.nextTick(() => callback(refusal(host)));
  };
  const lookupAsync = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) {
    return isPlatformHost(host) ? Promise.reject(refusal(host)) : lookupAsync.call(this, host, ...rest);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input);
    if (isPlatformUrl(url)) throw refusal(url);
    try {
      return await fetch(input, init);
    } catch (e) {
      throw e?.cause?.code === "C230_REFUSED" ? e.cause : e;
    }
  };
}
