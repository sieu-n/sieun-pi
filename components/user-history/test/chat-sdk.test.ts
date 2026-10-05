import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SdkSync } from "../src/chat-sdk.ts";

function fakeScript(dir: string, exitCode: number): string {
  const script = join(dir, `sync-${exitCode}.mjs`);
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(join(dir, "calls.txt"))}, process.argv.slice(2).join(" ") + "\\n");
    console.log(JSON.stringify({ step: "install", message: "Installing the chat packages." }));
    console.log(JSON.stringify({ step: ${exitCode === 0 ? '"done"' : '"failed"'}, message: ${exitCode === 0 ? '"The chat client now uses prime-agent 9.9.9."' : '"typecheck failed: TS2339"'} }));
    process.exit(${exitCode});
  `);
  return script;
}
const calls = (dir: string) => { try { return readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const settle = async (sync: SdkSync) => { for (let i = 0; i < 200; i++) { const view = await sync.view(); if (view.update.state !== "running") return view; await new Promise(r => setTimeout(r, 25)); } throw new Error("update did not settle"); };

test("sdk: a matching daemon runs nothing; a new daemon version updates once and restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-sdk-"));
  try {
    let restarts = 0;
    const sync = new SdkSync(join(dir, "sdk.json"), { client: "0.9.8", build: "b1", canRestart: true, restart: () => { restarts++; }, script: fakeScript(dir, 0) });
    await sync.daemonVersion("0.9.8");
    assert.deepEqual(calls(dir), []);
    assert.equal((await sync.view()).matched, true);
    await sync.daemonVersion("9.9.9");
    const view = await settle(sync);
    assert.deepEqual(calls(dir), ["--version 9.9.9 --json"]);
    assert.equal(view.update.state, "restarting");
    await new Promise(r => setTimeout(r, 700));
    assert.equal(restarts, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sdk: a failed update is kept across restarts and not retried until Retry or a new version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-sdk-"));
  try {
    const script = fakeScript(dir, 1);
    const options = { client: "0.9.8", build: "b1", canRestart: true, restart: () => { throw new Error("must not restart"); }, script };
    const first = new SdkSync(join(dir, "sdk.json"), options);
    await first.daemonVersion("9.9.9");
    const failed = await settle(first);
    assert.equal(failed.update.state, "failed");
    assert.match(failed.update.message, /TS2339/);
    const second = new SdkSync(join(dir, "sdk.json"), options);
    await second.daemonVersion("9.9.9");
    assert.equal((await second.view()).update.state, "failed", "the failure survives a restart");
    assert.equal(calls(dir).length, 1, "no automatic retry of the same version");
    await second.start();
    await settle(second);
    assert.equal(calls(dir).length, 2, "Retry runs it again");
    await second.setAuto(false);
    await second.daemonVersion("9.9.10");
    assert.equal(calls(dir).length, 2, "auto off runs nothing");
    assert.equal((await second.view()).auto, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
