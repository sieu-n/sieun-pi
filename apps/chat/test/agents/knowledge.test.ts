import assert from "node:assert/strict";
import { test } from "node:test";
import { compactPath, fileName, loadOrder, scriptSource } from "../../web/src/pages/agents/knowledge.ts";

test("a long path keeps its end and as much of its start as fits", () => {
  assert.equal(compactPath("/home/sieun/.prime/agent/skills/board/SKILL.md"), "~/.prime/agent/skills/board/SKILL.md");
  const release = "/home/sieun/.local/share/prime-agent/releases/0.9.8-daemon-fix.1-mem.4.2-s3int.9-crc.2-load.2.1-upd.3-load.3.9-test.51-linux-x64-3e5c3415ab65d4ff8312b54be46c702d80e2c4d30e132c9b5d4a234388c7a2e5/skills/edit/SKILL.md";
  const short = compactPath(release);
  assert.ok(short.length <= 64, short);
  assert.equal(short, "~/.local/share/prime-agent/releases/…/skills/edit/SKILL.md");
  assert.equal(compactPath(`/opt/${"x".repeat(80)}`), `/…/${"x".repeat(80)}`);
});

test("instruction files read in prompt order: global first, then each folder down to the cwd, AGENTS.md before CLAUDE.md", () => {
  const listed = ["/r/app/AGENTS.md", "/r/app/CLAUDE.md", "/r/AGENTS.md", "/p/AGENTS.md"].map(path => ({ path }));
  assert.deepEqual(loadOrder(listed).map(f => f.path), ["/p/AGENTS.md", "/r/AGENTS.md", "/r/app/AGENTS.md", "/r/app/CLAUDE.md"]);
});

test("a script row names its file and where it came from", () => {
  assert.equal(fileName("/a/b/sweep.mjs"), "sweep.mjs");
  assert.equal(scriptSource({ kind: "folder" }), "Kept in its folder");
  assert.equal(scriptSource({ kind: "brief" }), "Named in its brief");
  assert.equal(scriptSource({ kind: "duty", duty: "d2", name: "Vent integrations" }), "Duty d2, Vent integrations, runs it as its precheck");
});
