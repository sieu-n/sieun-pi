// 10-19 us-metal02: at 01:27Z and 01:53Z the chat service's sweep of deleted jobs deleted ~/scratch/retire-2547, release-fold and
// saved-session-archive whole, minutes after chat 01a14210 had read their EVIDENCE.md, PASS.md and calls.jsonl, so three finished jobs lost their
// evidence. A job's end now deletes only the repo copies in its ~/scratch trees, and every report, log and run file beside them stays.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a deleted job's end keeps the evidence in its ~/scratch trees and deletes only the repo copies there", { skip: process.platform === "win32" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-scratch-evidence-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const scratch = join(home, "scratch");
  const chat = join(home, ".prime", "agent", "session-artifacts", "01a14210-4e7d-72c3-aa67-e3d476f4e728");
  const job = join(chat, "sub-aaaa1111");
  mkdirSync(job, { recursive: true });
  const start = Date.now();
  await pause(30);
  const write = (path: string, text = "x") => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  write(join(scratch, "retire-2547", "EVIDENCE.md"), "# evidence");
  write(join(scratch, "retire-2547", "s1.sh"));
  write(join(scratch, "release-fold", "PASS.md"), "# pass");
  write(join(scratch, "release-fold", "e2e", "results.json"), "{}");
  write(join(scratch, "release-fold", "tree", "pnpm-workspace.yaml"));
  write(join(scratch, "release-fold", "tree", "scripts", "repo", "commit.mjs"));
  write(join(scratch, "release-fold", "tree", "EVIDENCE-in-export.md"));
  write(join(scratch, "release-fold", "e2e", "node_modules", "pkg", "index.js"));
  write(join(scratch, "saved-session-archive", "e2e", "runs", "SSA", "calls.jsonl"), "{}\n");
  write(join(scratch, "export", "NOTES.md"), "# notes");
  write(join(scratch, "export", "apps", "web", "package.json"), "{}");
  write(join(scratch, "export", "packages", "ui", "index.ts"));
  await pause(30);
  const transcript = join(job, "01a150f1-c33c-753f-9526-0cdb90358874.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session", version: 3, id: "x", timestamp: new Date(start).toISOString() }) + "\n" +
    JSON.stringify({ type: "message", text: "wrote ~/scratch/retire-2547/EVIDENCE.md, ~/scratch/release-fold/PASS.md, ~/scratch/saved-session-archive/e2e and ~/scratch/export" }) + "\n");
  writeFileSync(join(job, "rlm-subagent.json"), JSON.stringify({ status: "deleted" }));
  const left = await endLeftovers(leftoverSource, [job]);
  assert.deepEqual([...left.tmp].sort(), [
    join(scratch, "export", "apps"), join(scratch, "export", "packages"),
    join(scratch, "release-fold", "e2e", "node_modules"), join(scratch, "release-fold", "tree"),
  ]);
  for (const kept of ["retire-2547/EVIDENCE.md", "retire-2547/s1.sh", "release-fold/PASS.md", "release-fold/e2e/results.json",
    "saved-session-archive/e2e/runs/SSA/calls.jsonl", "export/NOTES.md"]) assert.ok(existsSync(join(scratch, kept)), kept);
  for (const gone of ["release-fold/tree", "release-fold/e2e/node_modules", "export/apps", "export/packages"]) assert.ok(!existsSync(join(scratch, gone)), gone);
});
