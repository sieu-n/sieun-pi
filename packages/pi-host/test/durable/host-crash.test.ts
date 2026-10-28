/**
 * SIGKILL pi-host while a durable thread's subagent streams, or while it sleeps on a pool slot, start a new pi-host on
 * the same folder, and check through the socket alone that the host reopened the thread by itself and the input was
 * answered once, with the child's answer as the tool result. Faux mode runs in CI; PI_DURABLE_REAL=1 adds the case on
 * the real claude-opus-5-5 through pi-pool.
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHILD_TASK, FAUX_CHILD_ANSWER, INPUT, textOf } from "./crash-scenario.ts";
import { HostClient } from "../../src/client.ts";
import type { HostCommand } from "../../src/protocol.ts";
import type { ThreadInfo, TreeNode } from "../../src/durable/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PI_STACK = join(here, "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-host-durable-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Every pi-host this file starts, so a failed case leaves none running. */
const hosts = new Set<ChildProcess>();
after(() => { for (const child of hosts) child.kill("SIGKILL"); });

interface Worker { child: ChildProcess; ready: Promise<{ recovered: string[] }>; stderr: () => string }

function startHost(socket: string, dir: string, mode: "faux" | "real", env: NodeJS.ProcessEnv): Worker {
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "host-worker.ts"), socket, dir, mode], { cwd: PI_STACK, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  hosts.add(child);
  child.once("exit", () => hosts.delete(child));
  let stderr = "";
  child.stderr!.on("data", chunk => (stderr += String(chunk)));
  const ready = new Promise<{ recovered: string[] }>((resolve, reject) => {
    createInterface({ input: child.stdout! }).on("line", line => {
      const event = JSON.parse(line) as { event: string; recovered: string[] };
      if (event.event === "ready") resolve(event);
    });
    child.once("exit", code => reject(new Error(`pi-host exited ${code} before ready:\n${stderr}`)));
  });
  return { child, ready, stderr: () => stderr };
}

const call = <T>(client: HostClient, command: Record<string, unknown>, timeoutMs = 120_000) => client.call<T>(command as unknown as HostCommand, timeoutMs);

type DurableLine = { type: "durable_event"; thread: string; event: { type: string; conversation?: number; events?: { type: string; [key: string]: unknown }[] } };
const durableLines = (client: HostClient) => client.lines.filter(line => (line as { type: string }).type === "durable_event") as unknown as DurableLine[];

async function allEntries(client: HostClient, thread: string, conversation: number): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await call<{ entries: EntryRecord[]; more: boolean }>(client, { type: "durable_entries", thread, conversation, limit: 50, ...(before === undefined ? {} : { before }) });
    out.push(...page.entries);
    if (!page.more || !page.entries.length) break;
    before = page.entries.at(-1)!.id;
  }
  return out.reverse();
}

const kinds = (entries: EntryRecord[]) => entries.map(entry => `${entry.kind}${(entry.model?.[0] as { stopReason?: string } | undefined)?.stopReason ? `(${(entry.model![0] as { stopReason: string }).stopReason})` : ""}`).join(" ");

interface PoolCall { argv: string[]; key: string | null }
interface CaseResult { calls: PoolCall[]; thread: string; killAfterMs: number; recovered: string[]; resumeMs: number; root: string; child: string; search: number; usageTurns: number }

async function crashCase(name: string, mode: "faux" | "real", killOn: "child-stream" | "slot-wait", pool: Record<string, unknown> = {}): Promise<CaseResult> {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "pool"), { recursive: true });
  writeFileSync(join(dir, "pool", "state.json"), JSON.stringify({ accounts: ["a1", "a2"], current: 0, ...pool }));
  const env = { FAKE_POOL_DIR: join(dir, "pool"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
  const socket = join(dir, "host.sock");

  const first = startHost(socket, dir, mode, env);
  await first.ready;
  const a = await HostClient.connect(socket);
  const { thread } = await call<{ thread: ThreadInfo }>(a, { type: "durable_create", name: "crash test" });
  await call(a, { type: "durable_doc_put", thread: thread.id, name: "chat.meta", value: { title: "crash test", kind: "solo" } });
  await call(a, { type: "durable_watch", thread: thread.id });
  const started = Date.now();
  const submitted = await call<{ submission: number; requestId: string; status: string }>(a, { type: "durable_submit", thread: thread.id, text: INPUT, requestId: "host-crash-1" });
  assert.ok(["queued", "placed"].includes(submitted.status), submitted.status);

  await a.waitFor(line => {
    const event = (line as unknown as DurableLine).event;
    if ((line as { type: string }).type !== "durable_event" || event?.type !== "events") return false;
    if (killOn === "slot-wait") return event.events!.some(e => e.type === "deferred_poll" || (e.type === "snapshot" && (e.generation as { deferred?: unknown } | undefined)?.deferred));
    return event.conversation !== 1 && event.events!.some(e => e.type === "message_update");
  }, mode === "real" ? 30 * 60_000 : 60_000);
  const killAfterMs = Date.now() - started;
  first.child.kill("SIGKILL");
  await new Promise(resolve => first.child.once("exit", resolve));
  a.close();
  assert.ok(!durableLines(a).some(line => line.event.events?.some(e => e.type === "run_end")), "the run ended before the kill");

  const resumedAt = Date.now();
  const second = startHost(socket, dir, mode, env);
  const { recovered } = await second.ready;
  const b = await HostClient.connect(socket);
  try {
    if (killOn === "child-stream") assert.deepEqual(recovered, [thread.id], second.stderr());
    const settled = await call<{ settled: { status: string; answer?: number } }>(b, { type: "durable_wait", thread: thread.id, submission: submitted.submission }, mode === "real" ? 600_000 : 120_000);
    const resumeMs = Date.now() - resumedAt;
    assert.equal(settled.settled.status, "done", second.stderr());
    const again = await call<{ submission: number; status: string }>(b, { type: "durable_submit", thread: thread.id, text: INPUT, requestId: "host-crash-1" });
    assert.equal(again.submission, submitted.submission, "the same request id must find the same submission");

    const tree = await call<{ conversations: TreeNode[] }>(b, { type: "durable_tree", thread: thread.id });
    assert.equal(tree.conversations.length, 2, JSON.stringify(tree));
    const childNode = tree.conversations.find(node => node.parent === 1)!;
    assert.equal(childNode.depth, 1);
    assert.equal(childNode.name, CHILD_TASK.slice(0, 80));

    const root = await allEntries(b, thread.id, 1);
    const child = await allEntries(b, thread.id, childNode.id);
    const users = root.filter(entry => entry.kind === "pi.user");
    assert.equal(users.length, 1, kinds(root));
    assert.equal(textOf(users[0]!.model![0]!.content as never), INPUT);
    assert.equal(child.filter(entry => entry.kind === "pi.user").length, 1, kinds(child));
    const childAnswers = child.filter(entry => entry.kind === "pi.assistant" && (entry.model![0] as { stopReason: string }).stopReason === "stop");
    assert.equal(childAnswers.length, 1, kinds(child));
    const results = root.filter(entry => entry.kind === "pi.tool-result");
    assert.equal(results.length, 1, kinds(root));
    const childText = textOf(childAnswers[0]!.model![0]!.content as never);
    assert.equal(textOf(results[0]!.model![0]!.content as never), childText);
    if (mode === "faux") assert.equal(childText, FAUX_CHILD_ANSWER);
    assert.equal(root.filter(entry => entry.kind === "pi.assistant" && (entry.model![0] as { stopReason: string }).stopReason === "stop").length, 1, kinds(root));

    assert.deepEqual(await call(b, { type: "durable_doc_get", thread: thread.id, name: "chat.meta" }), { value: { title: "crash test", kind: "solo" } });
    const { hits } = await call<{ hits: { conversation: number; snippet: string }[] }>(b, { type: "durable_search", q: "prime numbers", threads: [thread.id] });
    assert.ok(hits.some(hit => hit.conversation === childNode.id), JSON.stringify(hits));
    assert.ok(hits.every(hit => hit.snippet.includes("<mark>")));
    const { usage } = await call<{ usage: { thread: string; model: string; turns: number }[] }>(b, { type: "durable_usage", threads: [thread.id] });
    const turns = usage.filter(row => row.model === "anthropic/claude-opus-5-5").reduce((sum, row) => sum + row.turns, 0);
    assert.ok(turns >= 3, JSON.stringify(usage));
    const listed = await call<{ threads: ThreadInfo[] }>(b, { type: "durable_threads" });
    const row = listed.threads.find(t => t.id === thread.id)!;
    assert.equal(row.children, 1);
    assert.equal(row.status, "idle");
    // A settled input gives its slot back right after the settle commit, so the last release can trail durable_wait a little.
    const readCalls = () => readFileSync(join(dir, "pool", "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as PoolCall);
    const released = (calls: PoolCall[]) => calls.some(call => call.argv[1] === "release" && call.argv[2] === calls.find(c => c.argv[1] === "admit")?.argv[2]);
    let calls = mode === "faux" ? readCalls() : [];
    for (let tries = 0; mode === "faux" && !released(calls) && tries < 50; tries++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      calls = readCalls();
    }
    return { calls, thread: thread.id, killAfterMs, recovered, resumeMs, root: kinds(root), child: kinds(child), search: hits.length, usageTurns: turns };
  } finally {
    b.close();
    second.child.kill("SIGTERM");
    await new Promise(resolve => second.child.once("exit", resolve));
  }
}

describe("pi-host durable threads survive SIGKILL, faux", () => {
  test("SIGKILL while the subagent streams; the new host reopens the thread at start", async () => {
    const result = await crashCase("child-stream", "faux", "child-stream");
    assert.match(result.root, /pi\.assistant\(aborted\)|pi\.tool-result/);
  });

  test("SIGKILL during a pool slot wait; the new host's wake timer reopens and resumes it", async () => {
    await crashCase("slot-wait", "faux", "slot-wait", { waitUntil: Date.now() / 1000 + 20 });
  });

  test("every run waits its turn in pi-pool's queue, across a SIGKILL in the wait, and gives its slot back", async () => {
    const result = await crashCase("turn-wait", "faux", "slot-wait", { queuedTimes: 6 });
    const turnCalls = result.calls.filter(call => call.argv[0] === "--cli" && (call.argv[1] === "admit" || call.argv[1] === "release"));
    const sessions = [...new Set(turnCalls.map(call => call.argv[2]!))];
    assert.equal(sessions.length, 2, JSON.stringify(turnCalls.map(call => call.argv)));
    for (const session of sessions) {
      const mine = turnCalls.filter(call => call.argv[2] === session);
      assert.equal(mine.at(-1)!.argv[1], "release", `${session}: ${JSON.stringify(mine.map(call => call.argv.slice(1)))}`);
      assert.ok(JSON.parse(mine[0]!.key!).key.startsWith("pi-durable:"), mine[0]!.key!);
    }
    // No token went out before the first run was admitted: six queued answers came first.
    const firstVend = result.calls.findIndex(call => call.argv[0] !== "--cli");
    const admitsBefore = result.calls.slice(0, firstVend).filter(call => call.argv[1] === "admit").length;
    assert.ok(admitsBefore >= 7, `${admitsBefore} admits before the first vend`);
  });
});

describe("pi-host durable threads survive SIGKILL, real model through pi-pool", { skip: process.env.PI_DURABLE_REAL !== "1" }, () => {
  test("real claude-opus-5-5: SIGKILL while the subagent streams", async () => {
    const result = await crashCase("real-child-stream", "real", "child-stream");
    const out = process.env.PI_DURABLE_OUT;
    if (out) writeFileSync(join(out, "host-crash-real.json"), JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
});
