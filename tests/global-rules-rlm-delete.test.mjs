import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Prime 0.9.8 fails a subagent's run with "RLM quiescence wait cancelled" when it deletes a child that is still in
// its turn. These tests run the rewritten cell against a fake `rlm` module whose child is still writing, with or without a reply.
const root = mkdtempSync(join(tmpdir(), "global-rules-rlm-delete-"));
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const rlmDelete = await import("../packages/sieun-rules/src/rlm-delete.ts");
test.after(() => rmSync(root, { recursive: true, force: true }));

const FAKE_RLM = `
import types
_polls = 0
BUSY_POLLS = int(__import__("os").environ["BUSY_POLLS"])
REPLIED = __import__("os").environ["REPLIED"] == "1"
async def list_subagents():
    global _polls
    _polls += 1
    busy = _polls <= BUSY_POLLS
    return [types.SimpleNamespace(rlm_child_id="sub-1", session_name="leaf", session_id="s1", active_session_id="a1",
        replied_since_task=REPLIED, status="running" if busy else "completed", activity={"kind": "writing"} if busy else None)]
async def delete_subagent(target):
    print("deleted after", _polls, "polls")
    return target
class _RLMNamespace:
    async def delete_subagent(self, target):
        return await delete_subagent(target)
`;
mkdirSync(join(root, "rlm"));
writeFileSync(join(root, "rlm", "__init__.py"), FAKE_RLM);

const CELL = `import asyncio, rlm as _m
rlm = _m._RLMNamespace()
async def main():
    await rlm.delete_subagent("leaf")
asyncio.run(main())
`;

const header = (rlmDepth) => ({ sessionManager: { getHeader: () => ({ type: "session", rlmDepth }) } });
const rewrite = (code, depth) => {
  const event = { type: "tool_call", toolCallId: "t", toolName: "ipython", input: { code } };
  rlmDelete.onToolCall(event, header(depth));
  return event.input.code;
};
const run = (code, env) => {
  const result = spawnSync("python3", ["-B", "-c", code], { cwd: root, env: { ...process.env, PYTHONPATH: root, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("a subagent's delete waits until a child that replied is idle", () => {
  assert.equal(run(rewrite(CELL, 1), { BUSY_POLLS: "2", REPLIED: "1" }), "deleted after 3 polls");
});

const NOTE = "[harness] leaf was still running and had sent no reply since its task, so no report from it reached this session.";

test("a child that has not replied is deleted at once, with a note that no report from it arrived", () => {
  const [note, deleted] = run(rewrite(CELL, 1), { BUSY_POLLS: "5", REPLIED: "0" }).split("\n");
  assert.ok(note.startsWith(NOTE), note);
  assert.equal(deleted, "deleted after 1 polls");
});

// On 11-25 a top-level wiki dream job deleted seven running writers over reports it made up itself, and no line in the
// cell output said that none of them had replied.
test("a top-level session's delete of a running child that has not replied prints the note and does not wait", () => {
  const [note, deleted] = run(rewrite(CELL, 0), { BUSY_POLLS: "5", REPLIED: "0" }).split("\n");
  assert.ok(note.startsWith(NOTE), note);
  assert.equal(deleted, "deleted after 1 polls");
});

test("a top-level session's delete of a child that replied neither waits nor prints the note", () => {
  assert.equal(run(rewrite(CELL, 0), { BUSY_POLLS: "2", REPLIED: "1" }), "deleted after 1 polls");
});

test("a cell with no delete runs unchanged", () => {
  assert.equal(rewrite("print(1)", 0), "print(1)");
  assert.equal(rewrite("print(1)", 2), "print(1)");
});

test("the rewrite adds one line once", () => {
  for (const depth of [0, 1]) {
    const once = rewrite(CELL, depth);
    assert.equal(once.split("\n").length, CELL.split("\n").length + 1);
    assert.equal(rewrite(once, depth), once);
  }
});
