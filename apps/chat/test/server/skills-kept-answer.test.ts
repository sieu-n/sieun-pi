/**
 * GET /api/skills and GET /api/skills/inventory answer from bytes kept until the skills DB or the scan changes, with an ETag, and a
 * request that names it gets 304 with no body. On 11-23 the view was 3.4 MB as JSON and 252 KB as brotli, every open of the Skills page
 * downloaded it again at the owner's 200 ms round trip (p50 1,094 ms, p90 1,471 ms in the p155 rig), and 154 of 604 reads held the event
 * loop 100 to 400 ms to build and compress it (~/work/p155-sweep/fix-skills/notes.md). The serving process builds the view in a worker.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { SkillsDb } from "../../server/skills-db.ts";
import type { SkillsView } from "../../web/src/lib/api/shared/skills.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
  // The inventory's first ingest runs in a worker after the start.
  await until(() => s.get<SkillsView>("/api/skills"), view => view.counts.skills > 0);
});
after(async () => {
  await s.close();
});

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer }

function raw(path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(s.base + path, { headers: { "accept-encoding": "br", ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const decode = (answer: Raw): Buffer => (answer.headers["content-encoding"] === "br" ? brotliDecompressSync(answer.bytes) : answer.bytes);

for (const path of ["/api/skills", "/api/skills/inventory"]) {
  test(`${path} answers 304 with no body to the ETag of its last answer`, async () => {
    const first = await raw(path);
    assert.equal(first.status, 200);
    assert.equal(first.headers["cache-control"], "no-cache");
    const etag = first.headers.etag as string;
    assert.match(etag, first.headers["content-encoding"] === "br" ? /^"[\w-]+-br"$/ : /^"[\w-]+"$/);
    const body = JSON.parse(decode(first).toString()) as { scan: { running: boolean } };
    assert.equal(typeof body.scan.running, "boolean");
    const again = await raw(path, { "if-none-match": etag });
    assert.equal(again.status, 304);
    assert.equal(again.bytes.length, 0);
    assert.equal(again.headers.etag, etag);
    assert.equal((await raw(path, { "if-none-match": '"other"' })).status, 200);
  });
}

test("a change to the skills DB answers the old ETag with the new view", async () => {
  const first = await raw("/api/skills");
  const view = JSON.parse(decode(first).toString()) as SkillsView;
  const skill = view.skills.find(entry => entry.owner.kind !== "agent") ?? view.skills[0]!;
  const changed = await s.send("POST", "/api/skills/own", { skillId: skill.id, owner: "ag_agent-factory" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const after = await raw("/api/skills", { "if-none-match": first.headers.etag as string });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, first.headers.etag);
  const owned = (JSON.parse(decode(after).toString()) as SkillsView).skills.find(entry => entry.id === skill.id);
  assert.deepEqual(owned?.owner, { kind: "agent", id: "ag_agent-factory" });
});

test("a view built in a worker thread is the inline view, and a change builds it again", async t => {
  const dir = mkdtempSync(join(tmpdir(), "skills-view-worker-"));
  const config = { file: join(dir, "chat.sqlite"), box: "us-metal02", home: "/home/x", piHostPrompt: null };
  const db = new SkillsDb(config, { run: async () => [], undo: async () => [] });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const copy = (path: string) => ({ box: "mac", path, realPath: path, linkTarget: null, exists: true, name: "deploy-notes", source: "user-dir", root: "/Users/o/.claude/skills", runtimes: ["claude"], hash: "h1", text: "x" });
  db.ingest({ generatedAt: "2026-11-23T00:00:00Z", boxes: [{ box: "mac", scannedAt: "2026-11-23T00:00:00Z", ok: true }], copies: [copy("/Users/o/.claude/skills/deploy-notes")], usage: {} });
  db.viewsOffThread = true;
  const built = await db.viewJson();
  assert.equal(built, JSON.stringify(db.viewWithoutScan()));
  assert.equal(await db.viewJson(), built, "an unchanged DB answers the same text");
  db.ingest({ generatedAt: "2026-11-23T01:00:00Z", boxes: [{ box: "mac", scannedAt: "2026-11-23T01:00:00Z", ok: true }], copies: [copy("/Users/o/.claude/skills/deploy-notes"), copy("/Users/o/.claude/skills/other")], usage: {} });
  const next = await db.viewJson();
  assert.notEqual(next, built);
  assert.equal(next, JSON.stringify(db.viewWithoutScan()));
});
