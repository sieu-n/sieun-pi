#!/usr/bin/env node
/**
 * Writes a throwaway skills review set (server/skills-review-fixture.ts) for a walk or a test:
 *
 *   node scripts/skills-review-fixture.mjs <dir> [--name <set>] [--review-dir <review dir>]
 *
 * <dir> must be new or empty. The set registers as <review dir>/sets/<set>.json, ~/work/skills-review by default, so the live server lists it
 * and opens it at #/settings/skills/review?set=<set>. Every path in it sits under <dir>, and the server refuses a step outside it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeFixtureSet } from "../server/skills-review-fixture.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: "string" }, "review-dir": { type: "string" } } });
if (positionals.length !== 1) {
  console.error("usage: node scripts/skills-review-fixture.mjs <dir> [--name <set>] [--review-dir <review dir>]");
  process.exit(2);
}
const set = writeFixtureSet(positionals[0], { name: values.name ?? "fixture", reviewDir: values["review-dir"] ?? join(homedir(), "work/skills-review") });
console.log(JSON.stringify(set, null, 2));
