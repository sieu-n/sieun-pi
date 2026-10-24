// d11's verify runs read unlabeled_lines 57, 67, 14 and 41 on 10-22 while each labelling job left 0 or 1: the metric counted the run's own
// input queue. A line counts only when it went out before the newest run in LAST_RUNS_FILE that started a job, and every unlabeled line stays flagged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const chat = "01a00000-0000-7000-8000-000000000001";
const at = Date.parse;
const jobRun = at("2026-10-22T08:15:00Z");

function session(): string {
  let n = 0;
  const entry = (time: string, message: Record<string, unknown>) =>
    JSON.stringify({ type: "message", id: `e${++n}`, parentId: n > 1 ? `e${n - 1}` : null, timestamp: time, message: { ...message, timestamp: at(time) } });
  const told = (time: string, text: string) => [
    entry(time, { role: "user", content: [{ type: "text", text: "[check-in] a job finished" }] }),
    entry(time, { role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name: "tell_owner", arguments: { text } }], stopReason: "toolUse" }),
    entry(time, { role: "toolResult", toolCallId: `c${n - 1}`, toolName: "tell_owner", content: [{ type: "text", text: "sent" }], isError: false }),
    entry(time, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }),
  ];
  return [JSON.stringify({ type: "session", id: chat, version: CURRENT_SESSION_VERSION, timestamp: "2026-10-22T00:00:00Z", cwd: "/" }),
    ...told("2026-10-22T08:00:00.000Z", "before the job run"), ...told("2026-10-22T09:00:00.000Z", "after the job run")].join("\n") + "\n";
}

function precheck(lastRuns: unknown[] | undefined, labels: unknown[] = []): { metrics: Record<string, number>; flagged: { kind: string; excerpt: string }[] } {
  const home = mkdtempSync(join(tmpdir(), "d11-cutoff-"));
  try {
    const data = join(home, "data");
    mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
    mkdirSync(join(data, "owner-messages"), { recursive: true });
    writeFileSync(join(data, "owner-messages", "labels.jsonl"), labels.map(row => `${JSON.stringify(row)}\n`).join(""));
    writeFileSync(join(home, ".prime/agent/sessions", `${chat}.jsonl`), session());
    writeFileSync(join(data, "chats.json"), JSON.stringify({ ids: [chat] }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CHAT_DATA_DIR: data, OUTPUT_FILE: join(home, "out.json") };
    delete env.LAST_RUNS_FILE;
    if (lastRuns) { env.LAST_RUNS_FILE = join(home, "last-runs.json"); writeFileSync(env.LAST_RUNS_FILE, JSON.stringify(lastRuns)); }
    execFileSync(process.execPath, ["--import", "tsx", "scripts/duties/owner-messages.ts", "--end", "2026-10-22T10:00:00Z"], { env, cwd: join(import.meta.dirname, "..") });
    return JSON.parse(readFileSync(env.OUTPUT_FILE!, "utf8"));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("an unlabeled line before the newest job run counts, and one after it is flagged but not counted", () => {
  const output = precheck([{ duty: "d11", at: at("2026-10-22T09:30:00Z"), trigger: "verify" }, { duty: "d11", at: jobRun, trigger: "verify", job: { id: "j", name: "d11 job" } }]);
  assert.equal(output.metrics.unlabeled_lines, 1);
  assert.deepEqual(output.flagged.filter(item => item.kind === "unlabeled").map(item => item.excerpt.split("sent: ")[1]), ["before the job run", "after the job run"]);
  // 10-24: the 01:35Z run met, its job left the 00:54Z line unlabeled, and the 01:55Z run counted it.
  assert.deepEqual(output.flagged.filter(item => item.kind === "unlabeled").map(item => item.excerpt.startsWith("not counted yet, label it in this run even when every metric is met")), [false, true]);
});

test("with no LAST_RUNS_FILE or no run that started a job, every unlabeled line counts", () => {
  assert.equal(precheck(undefined).metrics.unlabeled_lines, 2);
  assert.equal(precheck([{ duty: "d11", at: jobRun, trigger: "verify" }]).metrics.unlabeled_lines, 2);
});

const cutJob = { id: "c", name: "d11 cut job" };
const cutRun = { duty: "d11", at: at("2026-10-22T08:30:00Z"), trigger: "rerun", job: cutJob, cut: { error: "token hook gave no token (credential_unavailable)", at: at("2026-10-22T08:40:00Z") } };
const earlierJobRun = { duty: "d11", at: at("2026-10-22T07:30:00Z"), trigger: "verify", job: { id: "e", name: "d11 earlier job" } };

test("a run whose job was cut before it wrote a label gives no cutoff, so the newest job run before it does", () => {
  assert.equal(precheck([cutRun, earlierJobRun]).metrics.unlabeled_lines, 0);
});

test("a cut run whose job wrote a label line by its name before the cut still gives the cutoff", () => {
  const label = { id: "m0-t0", label: "needed", case: "x", by: `${cutJob.name} (duty job of a chat)`, at: "2026-10-22T08:35:00Z" };
  assert.equal(precheck([cutRun, earlierJobRun], [label]).metrics.unlabeled_lines, 1);
  assert.equal(precheck([cutRun, earlierJobRun], [{ ...label, by: "another job" }]).metrics.unlabeled_lines, 0);
  assert.equal(precheck([cutRun, earlierJobRun], [{ ...label, at: "2026-10-22T08:45:00Z" }]).metrics.unlabeled_lines, 0);
});
