// The board skill's SKILL.md named `src/checkin-end-state.ts` on 10-23 (404009a1). The skill has its own src/ folder, so the d5 smoke check
// read the path as missing and counted prime:board as a skill to fix. This test runs the same path check over every skill in the repo.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { missingPaths } from "../scripts/duties/skill-smoke.ts";

const skills = fileURLToPath(new URL("../../../skills/", import.meta.url));

test("every repo skill names only paths that exist", async () => {
  const dirs = readdirSync(skills, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(skills, entry.name));
  const missing = (await Promise.all(dirs.map(async dir => (await missingPaths(dir)).map(line => `${dir}: ${line}`)))).flat();
  assert.deepEqual(missing, []);
});
