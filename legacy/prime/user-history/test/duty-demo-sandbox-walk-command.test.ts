// Guards d1's walk_problems after 17 missed runs from 10-18 01:03Z to 10-19 11:47Z: the duty job ran the walk over a plain `ssh mac`, whose PATH
// had no node, so playwright's shebang gave `env: node: No such file or directory` and the walk never ran. The run showed only walk_stale.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WALK_COMMAND, WALK_ERR_FILE, WALK_FILE, walkCommandBroke } from "../scripts/duties/demo-sandbox.ts";
import { macCommand } from "../scripts/duties/mac-reach.ts";

const NODE_MISSING = "env: node: No such file or directory\n";
const WARNING = "(node:18565) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n";
const deps = (err: string, errAt: number, walkAt?: number) => ({
  repo: "/repo",
  read: async (path: string) => { if (path === `/repo/${WALK_ERR_FILE}`) return err; throw new Error(`ENOENT ${path}`); },
  mtime: async (path: string) => {
    if (path === `/repo/${WALK_ERR_FILE}`) return errAt;
    if (path === `/repo/${WALK_FILE}` && walkAt !== undefined) return walkAt;
    throw new Error(`ENOENT ${path}`);
  },
});
const WALK_AT = Date.parse("2026-10-18T01:03:00Z");
const ERR_AT = Date.parse("2026-10-19T11:40:00Z");

test("a missing node after the last walk report is its own cause", async () => {
  assert.deepEqual(await walkCommandBroke(deps(WARNING + NODE_MISSING, ERR_AT, WALK_AT)), { at: ERR_AT, line: "env: node: No such file or directory" });
  assert.deepEqual(await walkCommandBroke(deps("zsh:1: command not found: playwright\n", ERR_AT)), { at: ERR_AT, line: "zsh:1: command not found: playwright" });
});

test("an Aside that does not answer is the walk command's cause (10-27, the walk moved to Aside, c177)", async () => {
  const line = "demo-sandbox-walk: Aside did not answer: Profile 0 is not connected to the daemon";
  assert.deepEqual(await walkCommandBroke(deps(WARNING + line + "\n", ERR_AT, WALK_AT)), { at: ERR_AT, line });
});

test("an older error file or a walk that only warned is not flagged", async () => {
  assert.equal(await walkCommandBroke(deps(NODE_MISSING, WALK_AT - 60_000, WALK_AT)), null);
  assert.equal(await walkCommandBroke(deps(WARNING, ERR_AT, WALK_AT)), null);
  assert.equal(await walkCommandBroke({ repo: "/repo", read: async () => { throw new Error("ENOENT"); }, mtime: async () => { throw new Error("ENOENT"); } }), null);
});

test("the walk command in onMiss sets the same node PATH as the precheck", () => {
  const duty = JSON.parse(readFileSync(new URL("../scripts/duties/demo-sandbox.duty.json", import.meta.url), "utf8")) as { onMiss: string };
  const path = macCommand("scripts/duties/demo-sandbox.ts").match(/export PATH=[^;]+;/)![0];
  const walk = duty.onMiss.match(/`(ssh mac '[^`]*demo-sandbox-walk\.ts[^`]*)`/)![1]!;
  assert.ok(walk.startsWith(`ssh mac '${path}`), walk);
  assert.ok(walk.includes(`/${WALK_ERR_FILE}"`), walk);
  assert.ok(walk.endsWith(`${WALK_COMMAND}'`), "onMiss runs the walk the precheck starts");
  assert.ok(!/playwright|shot-browser|headless/i.test(walk), "the walk drives Aside, never a headless browser (c177)");
});
