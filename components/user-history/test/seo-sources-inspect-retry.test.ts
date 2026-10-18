// Guards the 10-18 05:21Z New articles get indexed run: URL Inspection answered HTTP 500 "Internal error encountered" once for
// /ko/blog/kol-key-opinion-leader, so source_errors read 1 and new_unindexed_3d read 5, and the same URL read PASS when inspected again.
// This runs the real seo-sources.py inspect against a stub virev_seo whose first POST answers 500 and the second answers PASS.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureArticles, type ArticlesState, type InspectRead } from "../scripts/duties/seo-new-articles.ts";

const NOW = Date.parse("2026-10-18T05:21:00Z");
const ARTICLE = "https://virev.ai/ko/blog/kol-key-opinion-leader";
const SOURCES_PY = join(import.meta.dirname, "../scripts/duties/seo-sources.py");
const sitemap = `<urlset><url><loc>${ARTICLE}</loc><lastmod>2026-10-13</lastmod></url></urlset>`;
const page = `<meta property="article:published_time" content="2026-10-13T00:00:00Z">`;
const fakeFetch = (async (input: string | URL | Request) => new Response(String(input).endsWith("sitemap.xml") ? sitemap : page)) as typeof fetch;

const stubGsc = (dir: string): string => `
import json, os
INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
QUOTA = os.path.join(${JSON.stringify(dir)}, "quota.json")
POSTS = os.path.join(${JSON.stringify(dir)}, "posts.txt")

def _quota_used(day):
    return json.load(open(QUOTA)).get(day, 0) if os.path.exists(QUOTA) else 0

def _quota_add(day, n):
    data = json.load(open(QUOTA)) if os.path.exists(QUOTA) else {}
    data[day] = data.get(day, 0) + n
    json.dump(data, open(QUOTA, "w"))

class _Resp:
    def __init__(self, status, payload):
        self.status_code, self._payload = status, payload
        self.content = json.dumps(payload).encode()
    def json(self):
        return self._payload

class _Session:
    def post(self, url, json=None):
        with open(POSTS, "a") as f:
            f.write(json["inspectionUrl"] + "\\n")
        if len(open(POSTS).read().splitlines()) == 1:
            return _Resp(500, {"error": {"code": 500, "message": "Internal error encountered.", "status": "INTERNAL"}})
        return _Resp(200, {"inspectionResult": {"indexStatusResult": {"verdict": "PASS", "coverageState": "Submitted and indexed"}}})

def session(write=False):
    return _Session()
`;

function runInspect(stubRoot: string, urls: string[]): Promise<InspectRead> {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-B", SOURCES_PY, "inspect"], { encoding: "utf8", env: { ...process.env, PYTHONPATH: stubRoot } }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${error.message} ${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as InspectRead);
    });
    child.stdin?.end(urls.join("\n") + "\n");
  });
}

test("one URL Inspection 500 followed by a 200 ends PASS with source_errors 0, and both POSTs count in the quota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seo-inspect-retry-"));
  try {
    await mkdir(join(dir, "virev_seo"));
    await writeFile(join(dir, "virev_seo/__init__.py"), "");
    await writeFile(join(dir, "virev_seo/config.py"), `GSC_SITE = "sc-domain:virev.ai"\nINSPECT_DAILY_QUOTA = 2000\n`);
    await writeFile(join(dir, "virev_seo/gsc.py"), stubGsc(dir));
    const reads: InspectRead[] = [];
    const previous: ArticlesState = { indexed: {}, articles: { [ARTICLE]: { published: "2026-10-13", firstSeen: "2026-10-13", status: 200, kind: "article" } } };
    const { output, state } = await measureArticles({
      fetch: fakeFetch, now: () => NOW, inspect: async urls => { const read = await runInspect(dir, urls); reads.push(read); return read; },
      readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
    }, previous);
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.rows.length, 1);
    assert.equal(reads[0]!.rows[0]!.http, 200);
    assert.equal(reads[0]!.rows[0]!.verdict, "PASS");
    assert.equal(output.metrics.source_errors, 0);
    assert.equal(output.metrics.new_unindexed_3d, 0);
    assert.equal(state.indexed[ARTICLE], "2026-10-18");
    assert.equal((await readFile(join(dir, "posts.txt"), "utf8")).trim().split("\n").length, 2);
    assert.deepEqual(Object.values(JSON.parse(await readFile(join(dir, "quota.json"), "utf8"))), [2]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
