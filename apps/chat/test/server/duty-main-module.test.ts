/**
 * Duty prechecks run through the `current` symlink of an apps/chat release, and node resolves the main module to the release's real path,
 * so a main guard of `import.meta.url === \`file://${process.argv[1]}\`` never matched and the script exited 0 with no output (every agent's
 * Area review on 11-26). Each script now uses `isMain` (scripts/duties/main-module.ts); these tests run scripts through a symlink.
 * Run: cd apps/chat && node --test --test-force-exit --test-isolation=none test/server/duty-main-module.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { answeredBy, areaReview, remoteFolder, reviewOf, runAreaReview } from "../../scripts/duties/area-review.ts";
import { realAgents } from "../../scripts/duties/real-agents.ts";

const duties = fileURLToPath(new URL("../../scripts/duties/", import.meta.url));

test("isMain is true for a script started through a symlinked folder and false for an imported one", () => {
  const dir = mkdtempSync(join(tmpdir(), "is-main-"));
  const real = join(dir, "release");
  spawnSync("mkdir", ["-p", real]);
  writeFileSync(join(real, "probe.ts"), `import { isMain } from ${JSON.stringify(join(duties, "main-module.ts"))};\nconsole.log(isMain(import.meta.url) ? "main" : "imported");\n`);
  writeFileSync(join(real, "outer.ts"), `import "./probe.ts";\n`);
  symlinkSync(real, join(dir, "current"));
  const run = (script: string) => spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run(join(dir, "current", "probe.ts")).stdout.trim(), "main");
  assert.equal(run(join(real, "probe.ts")).stdout.trim(), "main");
  assert.equal(run(join(dir, "current", "outer.ts")).stdout.trim(), "imported");
});

test("area-review.ts run through a symlinked release writes OUTPUT_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "area-review-"));
  symlinkSync(duties, join(dir, "current"));
  const db = new DatabaseSync(join(dir, "chat.sqlite"));
  db.exec("CREATE TABLE agents_agents (id TEXT PRIMARY KEY, body TEXT); CREATE TABLE posts (room TEXT, ord INTEGER, body TEXT)");
  db.prepare("INSERT INTO agents_agents VALUES (?, ?)").run("ag_probe", JSON.stringify({ id: "ag_probe", slug: "probe", name: "probe", room: "dm_probe" }));
  db.prepare("INSERT INTO posts VALUES (?, ?, ?)").run("dm_probe", 1, JSON.stringify({ id: "p1", author: "owner", text: "hi", at: Date.now() }));
  db.close();
  const output = join(dir, "out.json");
  const run = spawnSync(process.execPath, [join(dir, "current", "area-review.ts"), "--agent", "ag_probe", "--db", join(dir, "chat.sqlite"), "--agents-dir", join(dir, "agents"), "--ledger", join(dir, "none.json")], {
    encoding: "utf8", env: { ...process.env, OUTPUT_FILE: output },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(output), `no OUTPUT_FILE; stderr: ${run.stderr}`);
  const json = JSON.parse(readFileSync(output, "utf8")) as { metrics?: Record<string, number> };
  assert.equal(typeof json.metrics?.wiki_pages_touched_24h, "number");
});

test("no duty script keeps the old main guard", () => {
  for (const name of readdirSync(duties).filter(file => file.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(join(duties, name), "utf8"), /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/, name);
  }
});

test("an agent on another box has its folder read through the chat server's folder route, and an away box reads as host_away with n = 0", async () => {
  const now = Date.now();
  const answer = {
    brief: { path: "/Users/sieunpark/.pi/agent/agents/5180-designer/brief.md", modifiedAt: now - 2 * 3_600_000 },
    workingMemory: { path: "/Users/sieunpark/.pi/agent/agents/5180-designer/working-memory.md", modifiedAt: now - 48 * 3_600_000 },
    memory: { entries: [
      { id: "c249_two_common_duties", kind: "memory", title: "c249", content: "keeps c249", updatedAt: new Date(now - 3_600_000).toISOString() },
      { id: "a_prompt", kind: "prompt", title: "not memory" },
    ] },
  };
  const urls: string[] = [];
  const mac = await remoteFolder("http://chat", { id: "ag_5180-designer", host: "mac" }, (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(answer));
  }) as typeof fetch);
  assert.deepEqual(urls, ["http://chat/api/agents/ag_5180-designer/folder", "http://chat/api/agents/ag_5180-designer/memory?limit=1000000"]);
  const agent = { id: "ag_5180-designer", slug: "5180-designer", name: "5180 designer", room: "dm_5180-designer", host: "mac" };
  const ledger = [{ id: "c249", rule: "two common duties", chat: { name: "5180 designer · #search-design" } }, { id: "c250", rule: "other", chat: { name: "5180 designer" } }];
  const review = reviewOf({ agent, corrections: ledger, posts: [], folder: mac, now });
  assert.deepEqual(review.metrics, { corrections_unsaved: 1, owner_posts_24h: 0, owner_posts_answered_24h: 0, wiki_pages_touched_24h: 1, memory_changed_24h: 1 });
  assert.equal(review.n, 3);
  const away = await remoteFolder("http://chat", { id: "ag_5180-designer", host: "mac" }, (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch);
  assert.deepEqual(away, { away: "mac" });
  const skipped = reviewOf({ agent, corrections: ledger, posts: [], folder: away, now });
  assert.equal(skipped.n, 0);
  assert.equal(skipped.metrics.corrections_unsaved, undefined, "an away box leaves the count out");
  assert.deepEqual(skipped.flagged.map(flag => [flag.kind, flag.host]), [["host_away", "mac"]]);
});

test("runAreaReview reads a Mac agent's folder through the server, and importing area-review.ts runs nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "area-review-mac-"));
  const db = new DatabaseSync(join(dir, "chat.sqlite"));
  db.exec("CREATE TABLE agents_agents (id TEXT PRIMARY KEY, body TEXT); CREATE TABLE posts (room TEXT, ord INTEGER, body TEXT)");
  db.prepare("INSERT INTO agents_agents VALUES (?, ?)").run("ag_mac", JSON.stringify({ id: "ag_mac", slug: "mac-agent", name: "mac agent", room: "dm_mac", host: "mac" }));
  db.close();
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/agents/ag_mac/folder"
      ? { memory: { entries: [{ id: "m1", kind: "memory", title: "t", updatedAt: new Date().toISOString() }] }, brief: { path: "/mac/brief.md", modifiedAt: Date.now() } }
      : {}));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    // The metal folder for this slug does not exist, so a local read would see no memory; the review must ask the server instead.
    const review = await runAreaReview({ agent: "ag_mac", db: join(dir, "chat.sqlite"), agentsDir: join(dir, "agents"), ledger: join(dir, "none.json"), server: `http://127.0.0.1:${port}`, box: "us-metal02" });
    assert.equal(review.metrics.memory_changed_24h, 1);
    assert.equal(review.metrics.wiki_pages_touched_24h, 1);
    assert.equal(review.n, 2);
  } finally {
    server.close();
  }
  // The test imported area-review.ts at the top and nothing printed or threw: its main block did not run on import.
  assert.equal(typeof runAreaReview, "function");
});

test("realAgents leaves out test and archived agents", () => {
  assert.deepEqual(realAgents([{ id: "ag_seo" }, { id: "ag_walk", test: true }, { id: "ag_old", archived: true }, { id: "ag_vent", archived: false, test: false }]).map(agent => agent.id), ["ag_seo", "ag_vent"]);
});

test("an owner post the agent answered reads as answered with the reply's id, and only unanswered posts count", () => {
  const now = Date.now();
  const agent = { id: "ag_fable-auditor", slug: "fable-auditor", name: "fable auditor", room: "dm_fable-auditor" };
  const posts = [
    { room: "dm_fable-auditor", id: "p1", author: "owner", text: "sweep again", at: now - 5 * 3_600_000 },
    { room: "dm_fable-auditor", id: "p2", author: "ag_fable-auditor", text: "done", at: now - 4 * 3_600_000, answers: "p1" },
    { room: "dm_fable-auditor", id: "p3", author: "owner", text: "and the boards?", at: now - 3 * 3_600_000 },
    { room: "dm_fable-auditor", id: "p4", author: "ag_fable-auditor", text: "boards read fine", at: now - 2 * 3_600_000 },
    { room: "ch_1", id: "p10", author: "owner", text: "@fable auditor check this", at: now - 3 * 3_600_000, mentions: ["ag_fable-auditor"] },
    { room: "ch_1", id: "p11", author: "ag_seo", text: "not me", at: now - 2 * 3_600_000, threadRoot: "p10" },
    { room: "ch_1", id: "p12", author: "owner", text: "@fable auditor in thread", at: now - 2 * 3_600_000, mentions: ["ag_fable-auditor"], threadRoot: "p10" },
    { room: "ch_1", id: "p13", author: "ag_fable-auditor", text: "top-level, not in the thread", at: now - 3_600_000 },
  ];
  assert.equal(answeredBy(posts[0]!, posts, agent.id), "p2");
  assert.equal(answeredBy(posts[2]!, posts, agent.id), "p4");
  assert.equal(answeredBy(posts[6]!, posts, agent.id), undefined);
  const review = areaReview({ agent, corrections: [], memory: {}, posts, folderTimes: [], now });
  assert.equal(review.metrics.owner_posts_24h, 1);
  assert.equal(review.metrics.owner_posts_answered_24h, 3);
  const owner = review.flagged.filter(flag => flag.kind === "owner_post");
  assert.deepEqual(owner.map(flag => [flag.sig, flag.answeredBy]), [["dm_fable-auditor/p1", "p2"], ["dm_fable-auditor/p3", "p4"], ["ch_1/p10", "p13"], ["ch_1/p12", null]]);
  assert.match(owner[3]!.excerpt, /ch_1 p12 \(not answered\)/);
});
