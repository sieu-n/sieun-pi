/**
 * Duty precheck: the sw factory wiki pages match the code they describe (owner, #sw-factory-build p223, 11-25, msg mww1x0do, c245: "keep
 * this (and all related docs, and all agents should be responsible for their llm-wiki docs btw)"). A page is current when its last_verified
 * is at or after the newest origin/main commit that touched its code, the `code` list in its <!--wiki--> meta: the repo files it describes,
 * such as "packages/pi-host/src/durable/room-tools.ts". A page with no list is counted apart and flagged with the files its text cites,
 * because a cited hub file such as apps/chat/server/app.ts changes many times a day: on 11-25 every page judged by its cited files read stale.
 *
 * It reads each page under domains/devops/sw-factory/ in the wiki's content folder (`contentRoot` of GET /wiki/api/agent/manifest), skips
 * archive/, evidence/ and assets/ and any page whose status is not current, and asks git in the sieun-pi checkout for each page's newest commit.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/docs-current.ts [--server http://127.0.0.1:5184] [--repo /home/sieun/src/sieun-pi]
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

export const SPACE = "domains/devops/sw-factory";
const SKIP = new Set(["archive", "evidence", "assets"]);
/** A repo path a page cites, such as `apps/chat/server/app.ts:42`; the line number is dropped. */
const CITED = /\b((?:apps|packages|scripts|skills|components|legacy|config)\/[\w.@/-]+\.(?:ts|mjs|js|svelte|md|json|py|sh|service))\b/g;

export interface Page { path: string; lastVerified: number | undefined; code: string[]; declared: boolean }
export interface Change { at: number; sha: string; subject: string }
export interface Flag { kind: string; sig: string; excerpt: string }

/** The page's meta and the code it describes, or undefined for a page the duty skips. `exists` says whether a cited path is a repo file. */
export function readPage(path: string, html: string, exists: (file: string) => boolean): Page | undefined {
  const head = /^<!--wiki\s*(\{[\s\S]*?\})\s*-->/.exec(html);
  let meta: { status?: string; last_verified?: string; code?: unknown } = {};
  try {
    meta = head ? JSON.parse(head[1]!) : {};
  } catch {
    meta = {};
  }
  if (meta.status && meta.status !== "current") return undefined;
  const at = meta.last_verified ? Date.parse(meta.last_verified) : NaN;
  const declared = Array.isArray(meta.code) && meta.code.every(item => typeof item === "string");
  const code = declared ? (meta.code as string[]) : [...new Set([...html.matchAll(CITED)].map(hit => hit[1]!))].filter(exists).sort();
  // `code` of a page with no list holds the files its text cites, for the flag only.
  return { path, lastVerified: Number.isFinite(at) ? at : undefined, code, declared };
}

/** The precheck output for `pages`, each with the newest commit that touched its code. */
export function docsCurrent(pages: readonly { page: Page; change: Change | undefined }[]): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let stale = 0;
  let reference = 0;
  let referenceCurrent = 0;
  let noCode = 0;
  for (const { page, change } of pages) {
    const isReference = page.path.startsWith(`${SPACE}/reference/`);
    if (isReference) reference += 1;
    if (!page.declared) {
      noCode += 1;
      if (isReference) reference -= 1;
      const cited = page.code.length ? `; its text cites ${page.code.slice(0, 6).join(", ")}${page.code.length > 6 ? ` and ${page.code.length - 6} more` : ""}` : "";
      flagged.push({ kind: "no_code", sig: page.path, excerpt: `${page.path} has no "code" list in its meta, so the duty cannot tell whether it is current${cited}` });
      continue;
    }
    const current = change === undefined || (page.lastVerified !== undefined && page.lastVerified >= change.at);
    if (current) {
      if (isReference) referenceCurrent += 1;
      continue;
    }
    stale += 1;
    const verified = page.lastVerified === undefined ? "no last_verified" : `last_verified ${new Date(page.lastVerified).toISOString().slice(0, 16)}Z`;
    flagged.push({
      kind: "stale_page", sig: `${page.path}@${change!.sha}`,
      excerpt: `${page.path} (${verified}) is older than ${change!.sha.slice(0, 8)} "${change!.subject.slice(0, 100)}" of ${new Date(change!.at).toISOString().slice(0, 16)}Z, which changed its ${page.declared ? "declared" : "cited"} code`,
    });
  }
  return {
    metrics: {
      reference_current_pct: reference ? Math.round((referenceCurrent / reference) * 1000) / 10 : 100,
      stale_pages: stale,
      pages_without_code: noCode,
      reference_pages_checked: reference,
      pages_checked: pages.length,
    },
    flagged,
  };
}

/** Every page file of the space, as wiki paths. */
function pageFiles(root: string, dir = join(root, SPACE)): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : pageFiles(root, join(dir, entry.name));
    return entry.name.endsWith(".html") ? [relative(root, join(dir, entry.name))] : [];
  });
}

/** The newest origin/main commit that touched any of `code`, or undefined when none did. */
function newestChange(repo: string, code: readonly string[]): Change | undefined {
  if (!code.length) return undefined;
  const line = execFileSync("git", ["-C", repo, "log", "-1", "--format=%ct%x09%H%x09%s", "origin/main", "--", ...code], { encoding: "utf8" }).trim();
  if (!line) return undefined;
  const [at, sha, ...subject] = line.split("\t");
  return { at: Number(at) * 1000, sha: sha!, subject: subject.join("\t") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { server: { type: "string" }, repo: { type: "string" } } });
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const repo = values.repo ?? process.env.SIEUN_PI_REPO ?? join(process.env.HOME ?? "", "src/sieun-pi");
  const manifest = await (await fetch(`${server}/wiki/api/agent/manifest`)).json() as { contentRoot: string };
  const exists = (file: string) => existsSync(join(repo, file));
  const pages = pageFiles(manifest.contentRoot).flatMap(path => readPage(path, readFileSync(join(manifest.contentRoot, path), "utf8"), exists) ?? []);
  const json = JSON.stringify(docsCurrent(pages.map(page => ({ page, change: page.declared ? newestChange(repo, page.code) : undefined }))), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}
