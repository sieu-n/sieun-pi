// 10-18 us-metal02: between 16:04Z and 16:34Z jobs added 7.5 GB of repo trees under ~/scratch, 0.66 GB per `git archive` export, and ~/scratch
// held 60 GB, most of it trees of jobs that had ended, so free space fell 295 GB in 14 hours. A job's end now deletes the ~/scratch trees it made,
// and keeps a tree a live sibling names or that anyone wrote in after the job's last line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { madeScratchTrees } from "../src/job-leftovers.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const header = (at: number) => JSON.stringify({ type: "session", version: 3, id: "x", timestamp: new Date(at).toISOString() }) + "\n";

function transcript(folder: string, id: string, at: number, text: string): string {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${id}.jsonl`);
  writeFileSync(file, header(at) + JSON.stringify({ type: "message", text }) + "\n");
  return file;
}

test("the ~/scratch trees a gone job made are the ones it names from ~, $HOME or /home/<user>, minus a tree a live sibling names or someone wrote in later", { skip: process.platform === "win32" }, async t => {
  const base = mkdtempSync(join(tmpdir(), "job-scratch-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "scratch");
  const artifacts = join(base, "session-artifacts");
  mkdirSync(join(root, "before"), { recursive: true });
  await pause(30);
  const start = Date.now();
  await pause(30);
  for (const name of ["tilde", "home", "env", "sibling", "listed", "written"]) mkdirSync(join(root, name, "tree", "apps"), { recursive: true });
  const chat = join(artifacts, "01a14dd5-e9d3-705d-bd63-245c21b2eee2");
  const job = join(chat, "sub-aaaa1111");
  transcript(chat, "01a14dd5-e9d3-705d-bd63-245c21b2eee2", start - 60_000, "the job reported ~/scratch/tilde/tree");
  const ended = transcript(job, "01a14e9c-5b57-7280-b497-b75dc6c20a74", start,
    "git archive HEAD | tar -x -C ~/scratch/tilde/tree; cd /home/someone/scratch/home/tree; ls $HOME/scratch/env ~/scratch/sibling ~/scratch/before " +
    "~/scratch/written ~/scratch/missing /tmp/scratch/other");
  writeFileSync(ended, JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "~/scratch/listed" }] } }) + "\n", { flag: "a" });
  transcript(join(chat, "sub-bbbb2222"), "01a14ea0-0000-7000-8000-000000000001", start, "took over /home/sieun/scratch/sibling/tree");
  const later = new Date(Date.now() + 60_000);
  writeFileSync(join(root, "written", "tree", "apps", "list.tsv"), "x");
  utimesSync(join(root, "written", "tree", "apps", "list.tsv"), later, later);
  const made = await madeScratchTrees([ended], [job], root, artifacts);
  assert.deepEqual(made.sort(), [join(root, "env"), join(root, "home"), join(root, "tilde")]);
});
