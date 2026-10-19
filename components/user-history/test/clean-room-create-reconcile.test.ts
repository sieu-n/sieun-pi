// Relative-duty run 20261019-1633: a refused create still made a chat, retries collided on its name, a timed-out create landed 135 s later, and
// setup --chat built the project again after the chat's first message had arrived.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { type CreateAnswer, type CreateIo, type CreateRecord, type FoundSession, createOrAdopt, findSession } from "../scripts/clean-room/create-reconcile.ts";

const WAITS = { lookupWaitsMs: [0, 10_000], boundMs: 1_500_000, stepMs: 2_000 };
const SCRIPT = join(import.meta.dirname, "../scripts/clean-room/clean-room.ts");

function rig(answers: ((record: CreateRecord) => CreateAnswer)[], sessions: (record: CreateRecord, look: number) => FoundSession | undefined = () => undefined) {
  let clock = Date.parse("2026-10-19T16:33:29.838Z");
  const posts: { name: string; requestId: string }[] = [];
  const archived: string[] = [];
  const delivered: { id: string; message: string; requestId: string }[] = [];
  const saved: CreateRecord[] = [];
  const lines: string[] = [];
  let looks = 0;
  let ids = 0;
  const io: CreateIo = {
    post: async record => { posts.push({ name: record.name, requestId: record.requestId }); const answer = answers.shift(); assert.ok(answer, "no answer left"); return answer(record); },
    find: async record => sessions(record, looks++),
    archive: async id => { archived.push(id); },
    deliver: async (id, message, requestId) => { delivered.push({ id, message, requestId }); },
    save: record => { saved.push(structuredClone(record)); },
    log: line => { lines.push(line); },
    newRequestId: () => `request-${++ids}`,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  return { io, posts, archived, delivered, saved, lines };
}
const record = (name: string): CreateRecord => ({ kind: "chat", name, names: [name], cwd: "/home/sieun/work/order-reports-20261019-1633", message: "can you put the order summary freshness check on this chat",
  requestId: "request-0", since: Date.parse("2026-10-19T16:33:29.838Z") });

test("a create with no answer is asked again under the same request id, which joins the create the server still runs", async () => {
  const { io, posts, archived, delivered, saved } = rig([
    () => ({ kind: "unknown", error: "This operation was aborted" }),
    () => ({ kind: "made", id: "01a15502-e4a9-76a9-9f9c-a9809135b5d6" }),
  ]);
  const one = record("stale summary check");
  assert.deepEqual(await createOrAdopt(one, io, WAITS), { id: "01a15502-e4a9-76a9-9f9c-a9809135b5d6", adopted: false });
  assert.deepEqual(posts, [{ name: "stale summary check", requestId: "request-0" }, { name: "stale summary check", requestId: "request-0" }]);
  assert.deepEqual(archived, []);
  assert.deepEqual(delivered, []);
  assert.equal(saved[0]!.requestId, "request-0", "the record is on disk before the first POST");
  assert.equal(saved.at(-1)!.id, "01a15502-e4a9-76a9-9f9c-a9809135b5d6");
});

test("a refused create that made a session anyway is archived, and the retry takes a free name instead of colliding", async () => {
  const stray: FoundSession = { id: "01a154da-d511-732e-8426-8ffce48ac191", name: "summary freshness", registered: false, delivered: false };
  const { io, posts, archived, delivered, lines } = rig([
    () => ({ kind: "refused", status: 502, error: "Daemon shutdown admission cancelled worker recovery" }),
    () => ({ kind: "made", id: "01a15502-0000-7000-8000-000000000001" }),
  ], (_record, look) => look === 1 ? stray : undefined);
  const one = record("summary freshness");
  assert.deepEqual(await createOrAdopt(one, io, WAITS), { id: "01a15502-0000-7000-8000-000000000001", adopted: false });
  assert.deepEqual(archived, [stray.id]);
  assert.deepEqual(delivered, []);
  assert.deepEqual(posts, [{ name: "summary freshness", requestId: "request-0" }, { name: "summary freshness 2", requestId: "request-1" }]);
  assert.deepEqual(one.names, ["summary freshness", "summary freshness 2"]);
  assert.ok(lines.some(line => line.includes("archived it")), lines.join("\n"));
});

test("a name refusal from a chat the run's own create registered adopts that chat and sends its first message once", async () => {
  const { io, posts, delivered } = rig([
    () => ({ kind: "refused", status: 502, error: 'Agent name "summary freshness" is unavailable: an agent of that name already exists at depth 0 under this parent' }),
  ], () => ({ id: "01a154da-d511-732e-8426-8ffce48ac191", name: "summary freshness", registered: true, delivered: false }));
  const one = record("summary freshness");
  assert.deepEqual(await createOrAdopt(one, io, WAITS), { id: "01a154da-d511-732e-8426-8ffce48ac191", adopted: true });
  assert.equal(posts.length, 1);
  assert.deepEqual(delivered, [{ id: "01a154da-d511-732e-8426-8ffce48ac191", message: one.message, requestId: "request-1" }]);
});

test("a name another session holds moves the create to the next free name", async () => {
  const { io, posts, archived } = rig([
    () => ({ kind: "refused", status: 502, error: 'Agent name "summary freshness" is unavailable: an agent of that name already exists at depth 0 under this parent' }),
    () => ({ kind: "made", id: "01a15502-0000-7000-8000-000000000002" }),
  ]);
  assert.equal((await createOrAdopt(record("summary freshness"), io, WAITS)).id, "01a15502-0000-7000-8000-000000000002");
  assert.deepEqual(posts.map(post => post.name), ["summary freshness", "summary freshness 2"]);
  assert.deepEqual(archived, []);
});

test("a record that already has its session is not created again", async () => {
  const { io, posts } = rig([]);
  assert.deepEqual(await createOrAdopt({ ...record("stale summary check"), id: "01a15502-e4a9-76a9-9f9c-a9809135b5d6" }, io, WAITS), { id: "01a15502-e4a9-76a9-9f9c-a9809135b5d6", adopted: false });
  assert.equal(posts.length, 0);
});

test("findSession matches name, folder and start, and reads registration and delivery from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "clean-room-find-"));
  try {
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const write = (id: string, at: string, name: string, folder: string, user: boolean) => {
      const file = join(root, `${id}.jsonl`);
      writeFileSync(file, [{ type: "session", version: 3, id, timestamp: at, cwd: folder }, { type: "session_info", id: "a", timestamp: at, name },
        ...(user ? [{ type: "message", id: "b", timestamp: at, message: { role: "user", content: [{ type: "text", text: "hi" }] } }] : [])].map(line => JSON.stringify(line)).join("\n") + "\n");
    };
    write("old", "2026-10-19T15:49:49.969Z", "stale summary check", cwd, true);
    write("elsewhere", "2026-10-19T16:33:35.401Z", "stale summary check", join(root, "other"), true);
    write("01a15502-e4a9-76a9-9f9c-a9809135b5d6", "2026-10-19T16:33:35.401Z", "stale summary check", cwd, true);
    const one = { ...record("stale summary check"), cwd, since: Date.parse("2026-10-19T16:33:29.838Z") };
    for (const id of ["old", "elsewhere", "01a15502-e4a9-76a9-9f9c-a9809135b5d6"]) utimesSync(join(root, `${id}.jsonl`), new Date(), new Date());
    assert.deepEqual(findSession(root, one, new Set(["01a15502-e4a9-76a9-9f9c-a9809135b5d6"])),
      { id: "01a15502-e4a9-76a9-9f9c-a9809135b5d6", name: "stale summary check", registered: true, delivered: true });
    assert.equal(findSession(root, one, new Set())?.registered, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function setupWith(chatCwd: string, delivered: boolean) {
  const checkIns: string[] = [];
  const srv = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => { checkIns.push(`${request.method} ${request.url} ${body}`); response.setHeader("content-type", "application/json"); response.end("{}"); });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "clean-room-adopt-"));
  const home = join(root, "home"), data = join(root, "data"), run = join(root, "runs", "20261019-1633");
  const chat = "01a15502-e4a9-76a9-9f9c-a9809135b5d6";
  mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true }); mkdirSync(data);
  writeFileSync(join(data, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/base/` }));
  writeFileSync(join(data, "configuration.json"), JSON.stringify({ csrfToken: "abc123" }));
  writeFileSync(join(root, "criteria.md"), "# criteria\n");
  writeFileSync(join(home, ".prime/agent/sessions", `${chat}.jsonl`), [
    { type: "session", version: 3, id: chat, timestamp: "2026-10-19T16:33:35.401Z", cwd: chatCwd },
    { type: "session_info", id: "a", timestamp: "2026-10-19T16:35:03.926Z", name: "stale summary check" },
    ...(delivered ? [{ type: "message", id: "b", timestamp: "2026-10-19T16:36:45.000Z", message: { role: "user", content: [{ type: "text", text: "can you put the order summary freshness check on this chat" }] } }] : []),
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", SCRIPT, "setup", "--scenario", "relative-duty", "--criteria", join(root, "criteria.md"),
    "--name", "stale summary check", "--every-min", "120", "--run", run, "--chat", chat],
  { env: { ...process.env, HOME: home, AGENT_CHAT_DATA_DIR: data, CLEAN_ROOM_SESSION: "", SIEUN_PI_HOSTS: join(root, "no-hosts.json") }, timeout: 60_000 })
    .then(({ stdout }) => ({ ok: true, text: stdout }), (error: { stderr?: string }) => ({ ok: false, text: error.stderr ?? String(error) }));
  const close = () => new Promise<void>((resolve, reject) => srv.close(error => error ? reject(error) : resolve()));
  return { root, home, run, chat, result, checkIns, close };
}

test("setup --chat after the first message arrived keeps the chat's project as it is and builds nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "clean-room-project-"));
  const project = join(root, "order-reports-20261019-1633");
  mkdirSync(join(project, "tools"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "the chat's own copy\n");
  const one = await setupWith(project, true);
  try {
    assert.ok(one.result.ok, one.result.text);
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "the chat's own copy\n");
    assert.equal(existsSync(join(one.home, "work")), false, "no project was built under ~/work");
    const state = JSON.parse(readFileSync(join(one.run, "run.json"), "utf8")) as { sandbox: string; chat: { id: string; name: string }; setupAt: number };
    assert.equal(state.sandbox, project);
    assert.deepEqual(state.chat, { id: one.chat, name: "stale summary check" });
    assert.equal(state.setupAt, Date.parse("2026-10-19T16:33:35.401Z"));
    assert.equal(existsSync(join(one.run, "setup.pending.json")), false);
    assert.ok(one.checkIns.every(line => !line.includes("api/threads ")), "no create was posted");
  } finally { await one.close(); rmSync(one.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("setup --chat whose project is gone after its first message stops instead of building it again", async () => {
  const gone = join(tmpdir(), "clean-room-gone-order-reports-20261019-1633");
  const one = await setupWith(gone, true);
  try {
    assert.equal(one.result.ok, false);
    assert.match(one.result.text, /is gone and its first message has arrived; adoption never builds a project again/);
    assert.equal(existsSync(gone), false);
    assert.equal(existsSync(join(one.home, "work")), false);
    assert.equal(one.checkIns.length, 0);
  } finally { await one.close(); rmSync(one.root, { recursive: true, force: true }); }
});
