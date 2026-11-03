// On 11-03 the wiki skill moved from auto-sns-agent to sieun-pi (fd771acb) and kept naming auto-sns-agent scripts, such as
// auto-sns-agent's `scripts/repo/release.mjs`, so the d5 smoke check counted prime:wiki as a skill to fix. A path on a line that names
// another checkout by its folder name now also resolves in that checkout.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missingPaths } from "../scripts/duties/skill-smoke.ts";

test("a path on a line that names another checkout resolves there, and a path it lacks stays missing", async t => {
  const root = mkdtempSync(join(tmpdir(), "skill-smoke-repos-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const other = join(root, "auto-sns-agent");
  mkdirSync(join(other, "scripts"), { recursive: true });
  writeFileSync(join(other, "scripts/release.mjs"), "");
  writeFileSync(join(other, "scripts/deploy.mjs"), "");
  const skill = join(root, "pi/skills/demo");
  mkdirSync(join(root, "pi/.git"), { recursive: true });
  mkdirSync(join(root, "pi/scripts"), { recursive: true });
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), [
    "1. Run auto-sns-agent's `scripts/release.mjs` to release.",
    "2. Run `scripts/deploy.mjs` here.",
    "3. Run auto-sns-agent's `scripts/gone.mjs` too.",
  ].join("\n"));
  assert.deepEqual(await missingPaths(skill, [other]), ["SKILL.md names scripts/deploy.mjs", "SKILL.md names scripts/gone.mjs"]);
});
