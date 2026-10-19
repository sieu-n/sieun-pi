// 10-19 us-metal02: at 15:19Z box-scratch-sweep deleted 23 trees, 2,191 files of them for good, because it took a tree for a deleted job's own
// whenever that job's tool calls named it. The sweep is gone (auto-sns-agent 2dd201e47), and a job's end is the one cleanup left. It deletes a
// path only when the deleted job listed it in its owned.json, and a path the job only named in a tool call stays.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a deleted job's end keeps every tree its tool calls only named and deletes the tree its owned.json lists", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-end-mentioned-"));
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nprintf 'ActiveState=inactive\\nTransient=no\\n'\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const chat = join(home, ".prime", "agent", "session-artifacts", "01a14210-4e7d-72c3-aa67-e3d476f4e728");
  const job = join(chat, "sub-59a424b1");
  mkdirSync(job, { recursive: true });
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "evidence"); return file; };
  const owned = write(join(home, "scratch", "own-export", "package.json"));
  const named = [
    write(join(home, "scratch", "mem3-decision-refresh", "EVIDENCE.md")),
    write(join(home, "scratch", "release-applied", "frozen", "release-chat.mjs")),
    write(join(home, "work", "paper-mcp-uninstall", "REPORT.md")),
  ];
  const toolCall = (code: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ipython", arguments: { code } }] } });
  writeFileSync(join(job, "01a15499-0000-7000-8000-000000000001.jsonl"), [
    toolCall("bash('ls ~/scratch/mem3-decision-refresh; node ~/scratch/release-applied/frozen/release-chat.mjs')"),
    toolCall(`open('${join(home, "work", "paper-mcp-uninstall", "REPORT.md")}','w'); bash('rm -rf $HOME/scratch/mem3-decision-refresh')`),
  ].join("\n") + "\n");
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: [join(home, "scratch", "own-export")], units: [] }));
  writeFileSync(join(job, "rlm-subagent.json"), JSON.stringify({ status: "deleted" }));

  const left = await endLeftovers(leftoverSource, [job]);

  assert.deepEqual([...left.owned], [join(home, "scratch", "own-export")]);
  assert.equal(existsSync(owned), false);
  assert.deepEqual(named.filter(file => !existsSync(file)), [], "a tree a deleted job only named stays");
});
