/**
 * GET /api/skills and GET /api/skills/inventory answer from bytes kept until the skills DB or the scan changes, with an ETag, and a
 * request that names it gets 304 with no body. On 11-23 the view was 3.4 MB as JSON and 252 KB as brotli, every open of the Skills page
 * downloaded it again at the owner's 200 ms round trip (p50 1,094 ms, p90 1,471 ms in the p155 rig), and 154 of 604 reads held the event
 * loop 100 to 400 ms to build and compress it (~/work/p155-sweep/fix-skills/notes.md). The serving process builds the view in a worker.
 * A read with `?since=` gets only the skills that changed since the version it holds: after the p155 walk's scans the whole view took
 * 1,189 ms to come down again (full2-1119bea), and a scan changed 35 of 609 skills.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { listedView, SkillsDb } from "../../server/skills-db.ts";
import { applyListed, type ListedAnswer } from "../../web/src/lib/api/shared/listed.ts";
import { fromWire, toWire, type SkillsView, type WireView } from "../../web/src/lib/api/shared/skills.ts";
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

test("a change to the skills DB answers the old ETag with the new view, and ?since= with only the skill that changed", async () => {
  const first = await raw("/api/skills");
  const view = JSON.parse(decode(first).toString()) as SkillsView;
  const held = applyListed<WireView>(null, await s.get<ListedAnswer>("/api/skills?since="), ["skills"])!;
  assert.deepEqual(fromWire(held.value), view, "a read with an empty since gets the whole view");
  assert.deepEqual(await s.get<ListedAnswer>(`/api/skills?since=${held.tag}`), { tag: held.tag, same: true });
  const skill = view.skills.find(entry => entry.owner.kind !== "agent") ?? view.skills[0]!;
  const changed = await s.send("POST", "/api/skills/own", { skillId: skill.id, owner: "ag_agent-factory" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const after = await raw("/api/skills", { "if-none-match": first.headers.etag as string });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, first.headers.etag);
  const now = JSON.parse(decode(after).toString()) as SkillsView;
  assert.deepEqual(now.skills.find(entry => entry.id === skill.id)?.owner, { kind: "agent", id: "ag_agent-factory" });
  const delta = await s.get<ListedAnswer & { entries: { id: string }[]; removed: string[] }>(`/api/skills?since=${held.tag}`);
  assert.deepEqual(delta.entries.map(entry => entry.id), [skill.id]);
  assert.deepEqual(delta.removed, []);
  assert.equal("order" in delta, false);
  assert.deepEqual(fromWire(applyListed(held, delta, ["skills"])!.value), now, "the changes on the held view make the new view");
  assert.equal("full" in await s.get<ListedAnswer>("/api/skills?since=unknown"), true, "a version the server does not know gets the whole view");
});

test("/api/skills/inventory?since= puts the rows back under inventory", async () => {
  const plain = JSON.parse(decode(await raw("/api/skills/inventory")).toString()) as unknown;
  const held = applyListed(null, await s.get<ListedAnswer>("/api/skills/inventory?since="), ["inventory", "skills"])!;
  assert.deepEqual(held.value, plain);
  assert.deepEqual(await s.get<ListedAnswer>(`/api/skills/inventory?since=${held.tag}`), { tag: held.tag, same: true });
});

test("a copy's checkout goes apart by box and root, and one that differs from its key's stays whole", () => {
  const checkout = { root: "/r", branch: "main", headAt: "2026-11-23T00:00:00Z", stale: false };
  const copy = (id: string, over: object = {}) => ({ id, box: "m", path: `/r/${id}`, checkout, ...over }) as unknown as SkillsView["unowned"][number];
  const view = { generatedAt: null, skills: [{ id: "s", copies: [copy("a"), copy("b", { checkout: { ...checkout, stale: true } }), copy("c", { checkout: null })] }] } as unknown as Omit<SkillsView, "scan">;
  const wire = toWire(view);
  assert.deepEqual(wire.checkouts, { "m:/r": checkout });
  assert.deepEqual(wire.skills[0]!.copies.map(c => c.checkout), ["m:/r", { ...checkout, stale: true }, null]);
  assert.deepEqual(fromWire(wire as unknown as WireView), view);
});

test("the changes since a version carry new rows, gone rows and the new order", () => {
  const held = { tag: "a", value: { n: 1, list: [{ id: "x", v: 1 }, { id: "y", v: 1 }, { id: "z", v: 1 }] } };
  const next = applyListed(held, { tag: "b", rest: { n: 2 }, entries: [{ id: "w", v: 1 }, { id: "y", v: 2 }] as unknown as { id: string }[], removed: ["x"], order: ["w", "z", "y"] }, ["list"]);
  assert.deepEqual(next, { tag: "b", value: { n: 2, list: [{ id: "w", v: 1 }, { id: "z", v: 1 }, { id: "y", v: 2 }] } });
  assert.equal(applyListed(null, { tag: "b", rest: {}, entries: [], removed: [] }, ["list"]), null, "changes need the version they apply to");
  assert.equal(applyListed(held, { tag: "c", same: true }, ["list"]), null, "same for another version reads again");
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
  const built = await db.viewListed();
  assert.deepEqual(built, listedView(db.viewWithoutScan()));
  assert.equal(await db.viewListed(), built, "an unchanged DB answers the same texts");
  db.ingest({ generatedAt: "2026-11-23T01:00:00Z", boxes: [{ box: "mac", scannedAt: "2026-11-23T01:00:00Z", ok: true }], copies: [copy("/Users/o/.claude/skills/deploy-notes"), copy("/Users/o/.claude/skills/other")], usage: {} });
  const next = await db.viewListed();
  assert.notEqual(next, built);
  assert.deepEqual(next, listedView(db.viewWithoutScan()));
});
