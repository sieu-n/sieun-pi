// Guards the Wiki tidiness duty of 2026-11-26: the auditor found d1 green while retired pages and walls of text stood in apps/ and domains/ (owner msg mwwklmfk).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";
import { listCuratedPages } from "../scripts/duties/wiki-skill-facts.ts";
import { measureTidiness, type Lint } from "../scripts/duties/wiki-tidiness.ts";

const DUTY = JSON.parse(readFileSync(new URL("../scripts/duties/wiki-tidiness.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] };
const LINT_URL = new URL("../../../../apps/wiki/src/lib/prose-lint.mjs", import.meta.url).href;
const lint = async (): Promise<Lint> => ((await import(LINT_URL)) as { lintHtml: Lint }).lintHtml;

const header = (fields: Record<string, string>): string =>
  `<!--wiki ${JSON.stringify({ description: "d", summary: "s", kind: "reference", updated: "2026-11-25", ...fields })}-->\n`;
const table = "<table><tr><th>Part</th><th>Where</th></tr><tr><td>the writer</td><td>a box</td></tr></table>\n";
const tidy = (title: string, status = "current"): string => `${header({ title, status })}<h1>${title}</h1>\n<p>The writer puts rows on a box.</p>\n${table}`;
const body = (title: string, status: string, after: string, before = ""): string =>
  `${header({ title, status })}<h1>${title}</h1>\n<p>The writer puts rows on a box.</p>\n${before}${table}${after}`;
const wall = (title: string, status = "current"): string =>
  body(title, status, "<p>The writer reads the queue first. Then it sorts each row by key. Then it checks each key. Then it writes the batch.</p>\n");
const fine = (title: string): string => body(title, "current", "<p>The writer reads the queue first. Then it sorts each row by key. Then it writes the batch.</p>\n");
const lead = (title: string, sentences: number): string =>
  body(title, "current", "", `<h2>Flow</h2>\n${Array.from({ length: sentences }, () => "<p>The writer reads each queue in turn and keeps the newest row for every key it sees.</p>\n").join("")}`);

function content(pages: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wiki-tidiness-"));
  for (const [path, text] of Object.entries(pages)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a retired or dated page outside archive/ and a wall of text count once each, and stubs, projects/, 3-sentence paragraphs and short leads do not", async () => {
  const { root, done } = content({
    "apps/x/index.html": tidy("X"),
    "apps/x/old.html": tidy("Old flow", "superseded"),
    "domains/devops/root-free-space/index.html": tidy("Root free space 10-25"),
    "domains/devops/moved.html": `<!--wiki {"title":"Moved","moved_to":"archive/domains/devops/moved.html"}-->\n<h1>Moved</h1>\n<p>This page moved.</p>\n`,
    "domains/devops/walls.html": wall("Walls"),
    "domains/devops/three-sentences.html": fine("Three sentences"),
    "domains/devops/short-lead.html": lead("Short lead", 2),
    "domains/devops/long-lead.html": lead("Long lead", 8),
    "domains/devops/walled-and-retired.html": wall("Walled", "archived"),
    "projects/p/index.html": wall("Project"),
  });
  try {
    const result = await measureTidiness({ content: root, listPages: () => listCuratedPages(root), readText: path => Promise.resolve(readFileSync(path, "utf8")), lint });
    assert.equal(result.metrics.source_errors, 0, JSON.stringify(result.flagged));
    assert.deepEqual(result.verdicts.map(verdict => [verdict.page, verdict.kinds.join("+")]), [
      ["apps/x/old.html", "retired"],
      ["domains/devops/root-free-space/index.html", "one_off"],
      ["domains/devops/walled-and-retired.html", "retired"],
      ["domains/devops/long-lead.html", "off_shape"],
      ["domains/devops/walls.html", "off_shape"],
    ]);
    assert.match(result.verdicts.find(verdict => verdict.page.endsWith("walls.html"))!.reasons[0]!, /^1 paragraph over 3 sentences or 80 words: L\d+ 4 sentences \d+ words/);
    assert.match(result.verdicts.find(verdict => verdict.page.endsWith("long-lead.html"))!.reasons[0]!, /\(\d{3} words\).*\(lead-visual\)$/);
    assert.deepEqual([result.metrics.retired_pages_shown, result.metrics.pages_off_shape, result.metrics.pages_needing_fix], [3, 2, 5]);
    assert.equal(result.info.redirect_stubs, 1);
    // Agent factory d7 (11-26) reads n per metric, so a met run on no page never reads green.
    assert.deepEqual(result.n, { pages_needing_fix: 8, retired_pages_shown: 8, pages_off_shape: 5, source_errors: 11 });
    assert.equal(judge(DUTY.metrics, result).verdict, "missed");
  } finally { done(); }
});

test("a lint that does not load writes 999999 for the page metrics and names the input", async () => {
  const { root, done } = content({ "apps/x/index.html": tidy("X"), "domains/y/index.html": tidy("Y"), "projects/p/index.html": tidy("P") });
  try {
    const result = await measureTidiness({ content: root, listPages: () => listCuratedPages(root), readText: path => Promise.resolve(readFileSync(path, "utf8")),
      lint: () => Promise.reject(new Error("no module")) });
    assert.equal(result.metrics.pages_needing_fix, 999_999);
    assert.equal(result.metrics.source_errors, 1);
    assert.match(result.flagged![0]!.excerpt, /prose-lint\.mjs: no module/);
  } finally { done(); }
});
