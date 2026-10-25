// chat-2572 p20 on 10-25: clean-room setups gave the head its first message at create, while setup still made fixtures and seeded the board.
// This runs `clean-room.ts setup` for the deferred unrelated-ci-controlled scenario against a fake chat service that runs a check-in on each
// tick while a created chat is not paused and keeps prompts by request id like the real outbox. The head's first message must find the
// fixture filed, the board seeded and the chat filed as a subject with the trial's harness store, no check-in may run before setup resumes it,
// and a lost prompt answer and a setup run again after a crash must neither send the task twice nor reseed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { TASK } from "../scripts/clean-room/unrelated-ci-controlled.ts";

const SCRIPT = join(import.meta.dirname, "../scripts/clean-room/clean-room.ts");
const CHAT = "01a17100-0000-7000-8000-0000000000aa";
const FIXTURE = "01a17100-0000-7000-8000-0000000000bb";
const OWNER = "01a16e22-91e0-7783-8ab3-dd7d6021ed6f";

interface Rig { srv: Server; root: string; home: string; data: string; run: string; events: string[]; prompts: string[]; seededAtTurn: boolean[];
  options: { dropFirstPromptAnswer: boolean; failResume: number } }

async function rig(options: Rig["options"]): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "deferred-setup-"));
  const home = join(root, "home"), data = join(root, "data"), run = join(root, "runs", "run-1");
  mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, "criteria.md"), "# controlled criteria\n");
  const events: string[] = [], prompts: string[] = [], seededAtTurn: boolean[] = [];
  let created = false, paused = false, dropped = false;
  const sessionFile = join(home, ".prime/agent/sessions", `${CHAT}.jsonl`);
  const stateReady = (): boolean => existsSync(join(data, "boards", `${CHAT}.json`)) &&
    readFileSync(join(data, "chat-jobs.json"), "utf8").includes(FIXTURE) &&
    readFileSync(join(data, "clean-room-subjects.json"), "utf8").includes(CHAT) &&
    readFileSync(join(data, "clean-room-harness.json"), "utf8").includes(CHAT);
  const srv = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") { response.end('<html data-chat-token="abc123"></html>'); return; }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const route = (request.url ?? "").replace(/^\/base\//, "");
      if (route === "api/threads") {
        if (parsed.kind === "chat") {
          assert.equal(parsed.deferFirst, true, "the head chat is created empty");
          assert.equal(parsed.message, "");
          if (!created) {
            created = true;
            paused = true;
            events.push("create empty chat, paused");
            writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: CHAT, timestamp: new Date().toISOString(), cwd: parsed.cwd }) + "\n");
          }
          response.end(JSON.stringify({ id: CHAT }));
          return;
        }
        events.push("create fixture");
        response.end(JSON.stringify({ id: FIXTURE }));
        return;
      }
      const [, id, action] = /^api\/threads\/([^/]+)\/([a-z-]+)$/.exec(route) ?? [];
      if (action === "check-in") {
        if (parsed.pause === null && options.failResume > 0) { options.failResume -= 1; response.statusCode = 400; response.end(JSON.stringify({ error: "refused once" })); return; }
        if (parsed.pause === "forever") paused = true;
        if (parsed.pause === null) { paused = false; events.push("resume"); }
        response.end("{}");
        return;
      }
      if (action === "prompt" && id === CHAT) {
        const rid = String(parsed.requestId);
        if (!prompts.includes(rid)) {
          prompts.push(rid);
          seededAtTurn.push(stateReady());
          events.push("head turn");
          writeFileSync(sessionFile, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: parsed.message }] } }) + "\n", { flag: "a" });
        }
        if (options.dropFirstPromptAnswer && !dropped) { dropped = true; request.socket.destroy(); return; }
        response.end(JSON.stringify({ id: rid }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: `no route ${route}` }));
    });
  });
  // The fake scheduler: a created chat that is not paused gets a check-in on each tick.
  const timer = setInterval(() => { if (created && !paused) events.push("check-in"); }, 5);
  srv.on("close", () => clearInterval(timer));
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(data, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/base/` }));
  writeFileSync(join(data, "configuration.json"), JSON.stringify({ csrfToken: "abc123" }));
  return { srv, root, home, data, run, events, prompts, seededAtTurn, options };
}

const setup = (one: Rig) => promisify(execFile)(process.execPath, ["--import", "tsx", SCRIPT, "setup", "--scenario", "unrelated-ci-controlled", "--criteria", join(one.root, "criteria.md"),
  "--name", "root free space", "--every-min", "15", "--run", one.run],
{ env: { ...process.env, HOME: one.home, AGENT_CHAT_DATA_DIR: one.data, CLEAN_ROOM_SESSION: OWNER, PRIME_AGENT_CODING_AGENT_DIR: join(one.home, ".prime/agent"),
  SIEUN_PI_HOSTS: join(one.root, "no-hosts.json") }, timeout: 120_000 })
  .then(({ stdout }) => ({ ok: true, text: stdout }), (error: { stderr?: string }) => ({ ok: false, text: error.stderr ?? String(error) }));
const close = (one: Rig) => new Promise<void>(resolve => one.srv.close(() => { rmSync(one.root, { recursive: true, force: true }); resolve(); }));

test("deferred setup: fixtures, board, subject and harness exist before the head's first message, and no check-in runs before the resume", async () => {
  const one = await rig({ dropFirstPromptAnswer: true, failResume: 0 });
  try {
    const result = await setup(one);
    assert.ok(result.ok, result.text);
    const turn = one.events.indexOf("head turn"), resume = one.events.indexOf("resume");
    assert.deepEqual(one.events.slice(0, 3), ["create empty chat, paused", "create fixture", "head turn"]);
    assert.ok(turn < resume && !one.events.slice(0, resume).includes("check-in"), one.events.join(", "));
    assert.deepEqual(one.seededAtTurn, [true], "the head's first message found the fixture, board, subject and harness filed");
    assert.equal(one.prompts.length, 1, "the lost answer was retried under the same request id, and the service kept one message");
    const admission = JSON.parse(readFileSync(join(one.run, "admission.json"), "utf8")) as { order: { step: string; at: number }[]; checkInsBeforeResume: number };
    assert.deepEqual(admission.order.map(entry => entry.step), ["created", "paused", "fixtures", "seeded", "delivered", "resumed"]);
    assert.equal(admission.checkInsBeforeResume, 0);
    const board = JSON.parse(readFileSync(join(one.data, "boards", `${CHAT}.json`), "utf8")) as { plan: { target?: { measuredAt?: string } }[] };
    const seededAt = Date.parse(board.plan[0]!.target!.measuredAt!);
    assert.ok(seededAt >= admission.order[0]!.at && seededAt <= admission.order.find(entry => entry.step === "seeded")!.at, "the first reading is taken at seed time");
    const state = JSON.parse(readFileSync(join(one.run, "run.json"), "utf8")) as { seeds: string[]; fixtures: Record<string, string>; windowStart: number };
    assert.equal(state.seeds[0], TASK);
    assert.deepEqual(state.fixtures, { "archive shelf count": FIXTURE });
    assert.equal(state.windowStart, admission.order[0]!.at);
  } finally { await close(one); }
});

test("deferred setup: a setup run again after a crash at the resume neither resends the task nor reseeds", async () => {
  const one = await rig({ dropFirstPromptAnswer: false, failResume: 1 });
  try {
    const first = await setup(one);
    assert.equal(first.ok, false, "the refused resume stops the first setup");
    const boardFile = join(one.data, "boards", `${CHAT}.json`);
    const seeded = statSync(boardFile).mtimeMs;
    const again = await setup(one);
    assert.ok(again.ok, again.text);
    assert.equal(one.prompts.length, 1);
    assert.equal(one.events.filter(event => event === "create fixture").length, 1);
    assert.equal(statSync(boardFile).mtimeMs, seeded, "the board was not seeded again");
    assert.ok(!one.events.slice(0, one.events.indexOf("resume")).includes("check-in"));
  } finally { await close(one); }
});
