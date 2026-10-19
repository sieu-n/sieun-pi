// 10-18 us-metal02: ~/.prime/agent/session-artifacts grew 10.6 GB between 02:30Z and 16:12Z. A grafana job left five `git archive` trees of
// 0.9 GB each in session-artifacts/grafana-c, and the 4,000 subagents the daemon had deleted still held 3.9 GB of kernel-state.dill. A job's end
// now deletes its sessions' kernel states and the repo copies in their own session folders, and keeps notes and every copy elsewhere in
// session-artifacts, since a path a transcript names proves no owner (10-19 02:06Z: a job's end deleted the shared ~/scratch/release-applied it named).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { artifactCopies, endLeftovers, type InsideProcess, kernelStates, type LeftoverSource } from "../src/job-leftovers.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const header = (at: number) => JSON.stringify({ type: "session", version: 3, id: "x", timestamp: new Date(at).toISOString() }) + "\n";

function put(root: string, path: string, text = "x"): string {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  return join(root, path);
}

function transcript(folder: string, id: string, at: number, text: string, result = ""): string {
  const lines = [header(at), JSON.stringify({ type: "message", text }) + "\n"];
  if (result) lines.push(JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: result }] } }) + "\n");
  return put(folder, `${id}.jsonl`, lines.join(""));
}

test("a gone job's kernel states and the repo copies in its own session folder are found, and notes and the copies it only names stay", { skip: process.platform === "win32" }, async t => {
  const artifacts = mkdtempSync(join(tmpdir(), "job-artifacts-"));
  t.after(() => rmSync(artifacts, { recursive: true, force: true }));
  const chat = join(artifacts, "01a11af8-962e-773d-a19a-ee4104011987");
  const job = join(chat, "sub-aaaa1111");
  const id = "01a14d5b-e84c-7659-a79b-0ec6e542e410";
  put(artifacts, "grafana-c/before/pnpm-workspace.yaml");
  put(artifacts, "other/t/pnpm-workspace.yaml");
  await pause(30);
  const start = Date.now();
  await pause(30);
  for (const name of ["kernel-state.dill", "kernel-state.dill.ab12cd34.tmp", "kernel-state.json"]) put(chat, `session-artifacts/${id}/${name}`);
  put(job, "tree/scripts/repo/agent/commit.mjs");
  put(job, "notes.md");
  put(artifacts, "grafana-c/c8tree/scripts/repo/agent/commit.mjs");
  put(artifacts, "grafana-c/c9tree/.git/HEAD");
  put(artifacts, "grafana-c/grafana-c-8-metal.diff");
  put(artifacts, `${id}/tree/pnpm-workspace.yaml`);
  transcript(join(chat, "sub-bbbb2222"), "01a14d6c-1373-742a-9cbf-cd51f6c9d61f", start, `tests ran in ~/.prime/agent/session-artifacts/grafana-c/c9tree`);
  await pause(30);
  const ended = transcript(job, id, start, `A=Path("~/.prime/agent/session-artifacts/grafana-c").expanduser(); X8=A/'c8tree'; ls ~/.prime/agent/session-artifacts/${id}`,
    `${artifacts}/other\n/home/x/.prime/agent/session-artifacts/other`);
  assert.deepEqual((await kernelStates([ended])).sort(), [join(chat, "session-artifacts", id, "kernel-state.dill"), join(chat, "session-artifacts", id, "kernel-state.dill.ab12cd34.tmp")]);
  assert.deepEqual(await artifactCopies([ended]), [join(job, "tree")]);
});

test("a job's end deletes its kernel states and the copies no process holds, and keeps a copy a process runs in", async () => {
  const [state, free, held] = ["/a/session-artifacts/01a14d5b-e84c-7659-a79b-0ec6e542e410/kernel-state.dill", "/a/grafana-c/c8tree", "/a/grafana-c/c9tree"];
  let removed: readonly string[] = [];
  const runner: InsideProcess = { pid: 7, bytes: 1, started: 7, command: "node --test", dir: held, session: null, prime: false, shared: false };
  const source: LeftoverSource = {
    strays: async () => [], started: async () => null, kill: () => {}, closeTabs: async () => 0, later: () => {}, removeCopies: async () => [],
    inside: async dirs => dirs.includes(held) ? [runner] : [], removeTmp: async paths => { removed = paths; return paths; },
    artifactCopies: async () => [free, held], kernelStates: async () => [state],
  };
  const base = mkdtempSync(join(tmpdir(), "job-artifacts-end-"));
  try {
    transcript(base, "01a14d5b-e84c-7659-a79b-0ec6e542e410", Date.now(), "ran");
    const left = await endLeftovers(source, base);
    assert.deepEqual(removed, [state, free]);
    assert.deepEqual(left.artifacts, [state, free]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
