// Owner 10-18: "btw when blind test done always clean up"; failed and void clean-room runs stayed in his chat list, For you and agents panel.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { FOLLOW_UP, TASK } from "../scripts/clean-room/owner-asks.ts";

test("a failed clean-room run is torn down when it is evaluated", async () => {
  const posts: string[] = [];
  const srv = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") { response.end(JSON.stringify({ agents: [{ sessionId: "job-1", key: "child:job-1", name: "ci time page", state: "idle" }] })); return; }
      posts.push(request.url ?? "");
      response.end("{}");
    });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "clean-room-teardown-"));
  const run = join(root, "clean-room", "owner-asks", "run-1");
  const sampler = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(run, "samples")], { stdio: "ignore" });
  try {
    const data = join(root, "data"), sessions = join(root, ".prime/agent/sessions");
    for (const dir of [run, join(data, "boards"), join(data, "wakes"), sessions]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(data, "configuration.json"), JSON.stringify({ csrfToken: "abc123", port: (srv.address() as AddressInfo).port, capability: "cap" }));
    writeFileSync(join(data, "check-in-settings.json"), "{}");
    writeFileSync(join(data, "service.log"), "");
    writeFileSync(join(data, "boards", "chat-1.json"), JSON.stringify({ v: 2, rev: 3, updatedAt: "2026-10-18T07:00:00.000Z", plan: [], todos: [{ id: "t1", text: "pick a chart style?", done: false, from: "agent", at: "2026-10-18T07:00:00.000Z" }] }));
    writeFileSync(join(data, "wakes", "chat-1-1791000000000.json"), "{}");
    writeFileSync(join(data, "wakes", "job-1-1791000000000.json"), "{}");
    writeFileSync(join(data, "wakes", "other-chat-1791000000000.json"), "{}");
    const line = (at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
    writeFileSync(join(sessions, "chat-1.jsonl"), [line("2026-10-18T06:00:00.000Z", TASK), line("2026-10-18T06:30:00.000Z", FOLLOW_UP)].join("\n") + "\n");
    writeFileSync(join(run, "criteria.md"), "a. the chat asks before it builds\n");
    writeFileSync(join(run, "run.json"), JSON.stringify({ scenario: "owner-asks", chat: { id: "chat-1", name: "ci time" }, fixtures: {}, sandbox: root, everyMs: 600_000,
      release: "release-test", board: "", seeds: [TASK, FOLLOW_UP], setupAt: 0, windowStart: 0, until: Date.now() + 3_600_000 }));
    await promisify(execFile)(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/clean-room/clean-room.ts"), "evaluate", "--run", run],
      { env: { ...process.env, HOME: root, AGENT_CHAT_DATA_DIR: data, CLEAN_ROOM_SESSION: "", SIEUN_PI_HOSTS: join(root, "no-hosts.json") }, timeout: 60_000 });

    assert.match(readFileSync(`${run}.fail.md`, "utf8"), /: fail/);
    assert.deepEqual(posts.sort(), ["/cap/api/threads/chat-1/archive", "/cap/api/threads/chat-1/check-in", "/cap/api/threads/job-1/archive"]);
    assert.deepEqual((JSON.parse(readFileSync(join(data, "boards", "chat-1.json"), "utf8")) as { todos: unknown[] }).todos, []);
    assert.ok(!existsSync(join(data, "wakes", "chat-1-1791000000000.json")));
    assert.ok(!existsSync(join(data, "wakes", "job-1-1791000000000.json")));
    assert.ok(existsSync(join(data, "wakes", "other-chat-1791000000000.json")));
    assert.ok(!existsSync(run), "the run folder is deleted");
    if (sampler.exitCode === null && sampler.signalCode === null) await new Promise(resolve => sampler.once("exit", resolve));
    assert.equal(sampler.signalCode, "SIGTERM");
  } finally {
    sampler.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => srv.close(error => error ? reject(error) : resolve()));
  }
});
