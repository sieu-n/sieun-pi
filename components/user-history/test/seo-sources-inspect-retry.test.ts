// Guards two URL Inspection failures through the real seo-sources.py inspect, against a stub virev_seo and a sitecustomize that records
// time.sleep instead of sleeping. On 10-18 at 05:21Z /ko/blog/kol-key-opinion-leader answered HTTP 500 "Internal error encountered" once
// and read PASS when inspected again. On 10-18 from 16:45:24Z to 16:48:36Z Google answered 500 or 503 to 81 calls of one 32-thread run.
// The stub's session() takes no argument, like virev_seo.gsc.session since auto-sns-agent c45b315b39 (10-25 15:12Z), whose Vent mints the
// scope per call. seo-sources.py inspect still called gsc.session(write=True) after it, so every d2 run read source_errors 1.
// Like virev_seo.gsc.VentSession.post since auto-sns-agent 64f4b0ac4, the stub session counts each inspection POST itself, so the quota
// assertions also catch seo-sources.py counting a POST a second time.
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

const stubGsc = (dir: string, failFirst: number, retryAfter: string | null, failStatus: number): string => `
import json, os, threading
INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
QUOTA = os.path.join(${JSON.stringify(dir)}, "quota.json")
POSTS = os.path.join(${JSON.stringify(dir)}, "posts.txt")
_lock = threading.Lock()
_posts = []

def quota_day():
    return "2026-10-18"

def _quota_used(day):
    return json.load(open(QUOTA)).get(day, 0) if os.path.exists(QUOTA) else 0

def _quota_add(day, n):
    data = json.load(open(QUOTA)) if os.path.exists(QUOTA) else {}
    data[day] = data.get(day, 0) + n
    json.dump(data, open(QUOTA, "w"))

class _Resp:
    def __init__(self, status, payload, headers):
        self.status_code, self._payload, self.headers = status, payload, headers
        self.content = json.dumps(payload).encode()
    def json(self):
        return self._payload

class _Session:
    def post(self, url, json=None):
        with _lock:
            if url == INSPECT_URL:
                _quota_add(quota_day(), 1)
            _posts.append(json["inspectionUrl"])
            n = len(_posts)
            with open(POSTS, "a") as f:
                f.write(json["inspectionUrl"] + "\\n")
        if n <= ${failFirst}:
            headers = {} if ${retryAfter === null ? "True" : "False"} else {"Retry-After": ${JSON.stringify(retryAfter)}}
            if ${failStatus} == 429:
                return _Resp(429, {"error": {"code": 429, "message": "Quota exceeded for sc-domain:virev.ai.", "status": "RESOURCE_EXHAUSTED"}}, headers)
            return _Resp(500, {"error": {"code": 500, "message": "Internal error encountered.", "status": "INTERNAL"}}, headers)
        return _Resp(200, {"inspectionResult": {"indexStatusResult": {"verdict": "PASS", "coverageState": "Submitted and indexed"}}}, {})

def session():
    return _Session()
`;

const sitecustomize = (dir: string): string => `
import time
def _sleep(seconds):
    with open(${JSON.stringify(join(dir, "sleeps.txt"))}, "a") as f:
        f.write(f"{seconds}\\n")
time.sleep = _sleep
`;

async function stubRoot(failFirst: number, retryAfter: string | null, failStatus = 500): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seo-inspect-retry-"));
  await mkdir(join(dir, "virev_seo"));
  await writeFile(join(dir, "virev_seo/__init__.py"), "");
  await writeFile(join(dir, "virev_seo/config.py"), `GSC_SITE = "sc-domain:virev.ai"\nINSPECT_DAILY_QUOTA = 2000\n`);
  await writeFile(join(dir, "virev_seo/gsc.py"), stubGsc(dir, failFirst, retryAfter, failStatus));
  await writeFile(join(dir, "sitecustomize.py"), sitecustomize(dir));
  return dir;
}

function runInspect(dir: string, urls: string[]): Promise<InspectRead> {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-B", SOURCES_PY, "inspect"], { encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${error.message} ${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as InspectRead);
    });
    child.stdin?.end(urls.join("\n") + "\n");
  });
}

const lines = async (file: string): Promise<string[]> => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);

test("one URL Inspection 500 with no Retry-After is asked again after REASK_WAIT_S, ends PASS with source_errors 0, and both POSTs count", async () => {
  const dir = await stubRoot(1, null);
  try {
    const previous: ArticlesState = { indexed: {}, articles: { [ARTICLE]: { published: "2026-10-13", firstSeen: "2026-10-13", status: 200, kind: "article" } } };
    const { output, state } = await measureArticles({
      fetch: fakeFetch, now: () => NOW, inspect: urls => runInspect(dir, urls),
      readProgram: async () => { throw new Error("absent"); }, listMetrics: async () => [],
    }, previous);
    assert.equal(output.metrics.source_errors, 0);
    assert.equal(output.metrics.new_unindexed_3d, 0);
    assert.equal(state.indexed[ARTICLE], "2026-10-18");
    assert.deepEqual(await lines(join(dir, "sleeps.txt")), ["240"]);
    assert.equal((await lines(join(dir, "posts.txt"))).length, 2);
    assert.deepEqual(Object.values(JSON.parse(await readFile(join(dir, "quota.json"), "utf8"))), [2]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a run of 500s stops new calls, waits Google's Retry-After once, and every POST counts in the quota", async () => {
  const dir = await stubRoot(1_000, "7");
  try {
    const urls = Array.from({ length: 40 }, (_, i) => `https://virev.ai/blog/page-${i}`);
    const read = await runInspect(dir, urls);
    const posts = (await lines(join(dir, "posts.txt"))).length;
    assert.equal(read.rows.length, 40);
    assert.ok(read.rows.every(row => row.http === 500 || row.error === "not asked: URL Inspection failed earlier in this run"));
    assert.ok(read.rows.some(row => row.http === 0), "the URLs after the first 500 are not asked");
    assert.ok(posts <= 64, `each of the 2 passes starts at most one call per thread, got ${posts}`);
    assert.deepEqual(await lines(join(dir, "sleeps.txt")), ["7.0"]);
    assert.deepEqual(Object.values(JSON.parse(await readFile(join(dir, "quota.json"), "utf8"))), [posts]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a 429 for the daily quota stops new calls and asks no URL again, since the quota resets only at 00:00Z", async () => {
  const dir = await stubRoot(1_000, null, 429);
  try {
    const urls = Array.from({ length: 40 }, (_, i) => `https://virev.ai/blog/page-${i}`);
    const read = await runInspect(dir, urls);
    const posts = (await lines(join(dir, "posts.txt"))).length;
    assert.ok(read.rows.every(row => row.http === 429 || row.error === "not asked: URL Inspection failed earlier in this run"));
    assert.ok(posts <= 32, `one pass starts at most one call per thread, got ${posts}`);
    assert.deepEqual(await lines(join(dir, "sleeps.txt")), []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "quota.json"), "utf8")), { "2026-10-18": posts });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
