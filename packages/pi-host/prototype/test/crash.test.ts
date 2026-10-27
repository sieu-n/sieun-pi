/**
 * Kill the durable host with SIGKILL mid-turn, reopen the same SQLite file in a new process, resume, and check the input
 * is answered once with the subagent's result in the transcript. Faux mode runs the faux provider behind the real pool
 * wrapper and ../../../pi-pool/test/fake-pool.mjs, so CI needs no model. PI_DURABLE_REAL=1 runs it once on the real model
 * through pi-pool and writes the report to PI_DURABLE_OUT (default ~/work/pi-durable-fit).
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { crashAndResume, problems, shape, type CrashResult, type KillPoint } from "./crash-rig.ts";
import { FAUX_CHILD_ANSWER, FAUX_FINAL } from "./crash-scenario.ts";
import { SLOT_OPEN_TEXT } from "../src/pool-provider.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-durable-crash-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fauxCase(name: string, pool: Record<string, unknown> = {}) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "pool"), { recursive: true });
  writeFileSync(join(dir, "pool", "state.json"), JSON.stringify({ accounts: ["a1", "a2"], current: 0, ...pool }));
  return { file: join(dir, "session.sqlite"), env: { FAKE_POOL_DIR: join(dir, "pool"), PI_OFFLINE: "1", PI_TELEMETRY: "0" }, calls: () => readFileSync(join(dir, "pool", "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; key: string | null; protocol: string | null }) };
}

function assertWhole(result: CrashResult) {
  assert.deepEqual(problems(result), [], [...shape(result.before), "after:", ...shape(result.after)].join("\n"));
  const root = result.after.find(c => c.owner === null)!;
  assert.equal(root.entries.find(e => e.kind === "pi.tool-result")?.text, FAUX_CHILD_ANSWER);
  assert.equal(root.entries.filter(e => e.stopReason === "stop").at(-1)?.text, FAUX_FINAL);
}

describe("pi-durable crash and resume, faux", () => {
  test("SIGKILL while the root's model stream runs", async () => {
    const c = fauxCase("root-stream");
    const result = await crashAndResume(c.file, "faux", c.env, "root-partial", 300);
    assertWhole(result);
    const root = result.after.find(x => x.owner === null)!;
    // The cut-off request is kept as an aborted entry, and the retry answered.
    assert.ok(root.entries.some(e => e.kind === "pi.assistant" && e.stopReason === "aborted"), shape(result.after).join("\n"));
  });

  test("SIGKILL while the child task's model stream runs", async () => {
    const c = fauxCase("child-stream");
    const result = await crashAndResume(c.file, "faux", c.env, "child-partial", 300);
    assertWhole(result);
    const before = result.before.find(x => x.owner !== null);
    assert.ok(before, "the child conversation was stored before the kill");
    const key = JSON.parse(c.calls().find(call => call.argv[0] === "--provider")!.key!) as { key: string };
    assert.equal(key.key, `pi-durable:${c.file}`, "every vend speaks for the session file's tree");
  });

  test("SIGKILL during a pool slot wait; the stored sleep resumes and sends the request at the slot", async () => {
    const waitSec = 4;
    const c = fauxCase("slot-wait", { waitUntil: Date.now() / 1000 + waitSec });
    const result = await crashAndResume(c.file, "faux", c.env, "root-slot-wait");
    const root = result.before.find(x => x.owner === null)!;
    assert.ok((root.live as { generation?: { deferred?: unknown } }).generation?.deferred, "the slot wait is a stored sleep before the restart");
    assertWhole(result);
    const after = result.after.find(x => x.owner === null)!;
    assert.equal(after.entries.filter(e => e.error === SLOT_OPEN_TEXT).length, 1, shape(result.after).join("\n"));
    const vends = c.calls().filter(call => call.argv[0] === "--provider");
    assert.ok(vends.length >= 3 && vends.every(call => call.protocol === "1"), `vends ${vends.length}`);
    assert.ok(result.resume.endedAt >= (result.start.startedAt + waitSec * 1000), "the request waited for the slot");
  });
});

const realOut = process.env.PI_DURABLE_OUT || join(homedir(), "work", "pi-durable-fit");
describe("pi-durable crash and resume, real model through pi-pool", { skip: process.env.PI_DURABLE_REAL !== "1" }, () => {
  for (const killPoint of (process.env.PI_DURABLE_KILL ?? "child-partial").split(",") as KillPoint[]) {
    const killDelayMs = Number(process.env.PI_DURABLE_KILL_DELAY_MS ?? 1000);
    test(`SIGKILL ${killDelayMs} ms after ${killPoint} on anthropic/claude-opus-5-5`, { timeout: 15 * 60_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), `pi-durable-real-${killPoint}-`));
      const file = join(dir, "session.sqlite");
      const result = await crashAndResume(file, "real", { PI_OFFLINE: "1", PI_TELEMETRY: "0" }, killPoint, killDelayMs);
      const found = problems(result);
      const firstEvent = result.start.events[0]?.at ?? result.start.startedAt;
      const report = {
        killPoint,
        killDelayMs,
        file,
        startEvents: result.start.events.map(e => ({ event: e.event, msAfterOpen: e.at - firstEvent })),
        killedAfterOpenMs: result.killedAt === undefined ? null : result.killedAt - firstEvent,
        before: shape(result.before),
        after: shape(result.after),
        resumeMs: result.resumeMs,
        settled: result.settled?.status,
        problems: found,
        transcripts: result.after,
        reports: result.resume.events.filter(e => e.event === "report"),
        stderr: result.resume.stderr.slice(-4000),
      };
      mkdirSync(realOut, { recursive: true });
      writeFileSync(join(realOut, `crash-real-${killPoint}-${killDelayMs}ms.json`), JSON.stringify(report, null, 2));
      assert.deepEqual(found, [], JSON.stringify(report, null, 2).slice(0, 6000));
    });
  }
});

