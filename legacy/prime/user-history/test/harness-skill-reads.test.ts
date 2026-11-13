// d5 on 11-01 flagged prime:principle-sequence-verifiable-units as unread since 10-18, while er-truthset read it on 10-28 through
// f'/home/sieun/.prime/agent/skills/{n}/SKILL.md' with n taken from a list, a path the skills/<name> pattern never sees.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markReads, READS_VERSION, transcriptReads, type ReadState, type Skill, type SkillRoot } from "../scripts/duties/harness-health.ts";

const roots: SkillRoot[] = [{ name: "prime", dir: "/skills", transcripts: true }];
const skill = (name: string): Skill => ({ id: `prime:${name}`, root: "prime", dir: `/skills/${name}`, description: "" });
const skills = [skill("principle-sequence-verifiable-units"), skill("arena")];
const since = Date.parse("2026-10-18T00:00:00Z");

const call = (ts: string, code: string) => ({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", name: "ipython", arguments: { code } }] } });
const result = (ts: string, text: string) => ({ type: "message", timestamp: ts, message: { role: "toolResult", toolName: "ipython", content: [{ type: "text", text }] } });

async function reads(entries: object[], tracked = skills, under = roots): Promise<Record<string, string>> {
  const file = join(mkdtempSync(join(tmpdir(), "skill-reads-")), "session.jsonl");
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const state: ReadState = { version: READS_VERSION, offsets: {}, reads: {} };
  return Object.fromEntries((await transcriptReads([file], tracked, under, since, state)).map(view => [view.path, view.ts]));
}

const repoRoots: SkillRoot[] = [{ name: "repo", dir: "/repo/.agents/skills", views: "@code/.agents/skills/", transcripts: true }];
const repoSkill = (id: string): Skill => ({ id: `repo:${id}`, root: "repo", dir: `/repo/.agents/skills/${id}`, description: "" });

test("a tool result that shows a skill's SKILL.md counts as a read, however the call built the path", async () => {
  const found = await reads([
    call("2026-10-28T20:36:56.000Z", "for n in ['principle-build-the-lever','principle-sequence-verifiable-units']:\n    p=f'/home/sieun/.prime/agent/skills/{n}/SKILL.md'\n    print('=====',n); print(open(p).read())"),
    result("2026-10-28T20:36:56.128Z", "===== principle-sequence-verifiable-units\n---\nname: principle-sequence-verifiable-units\ndescription: \"Apply to multi-step work.\"\ndisable-model-invocation: true\n---\n# Sequence work into verifiable units\n"),
  ]);
  assert.deepEqual(found, { "prime:principle-sequence-verifiable-units/": "2026-10-28T20:36:56.128Z" });
});

test("a skill name in a table or a diff of a SKILL.md is no read", async () => {
  const found = await reads([
    result("2026-10-28T20:00:00.000Z", "| principle-sequence-verifiable-units | Work has many steps. |\n"),
    result("2026-10-28T20:01:00.000Z", "@@ -1,3 +1,3 @@\n ---\n name: arena\n-description: old\n"),
  ]);
  assert.deepEqual(found, {});
});

test("a read before the window is no read", async () => {
  assert.deepEqual(await reads([result("2026-10-10T00:00:00.000Z", "---\nname: arena\ndescription: x\n---\n")]), {});
});

test("a repo skill read through rg of its reference or read-skill.mjs counts, and so does its view event (d5 11-13)", async () => {
  const tracked = [repoSkill("repo/skill-creation"), repoSkill("stack/dataviz"), repoSkill("stack/python")];
  const found = await reads([
    call("2026-11-09T09:06:00.000Z", "r=await bash(\"rg -n -i 'crawler' .agents/skills/repo/skill-creation/references/skill-map.md\")"),
    call("2026-11-08T10:59:00.000Z", "r=await bash('node scripts/skills/read-skill.mjs stack/dataviz 2>/dev/null | head -120')"),
  ], tracked, repoRoots);
  assert.deepEqual(found, { "repo:repo/skill-creation/": "2026-11-09T09:06:00.000Z", "repo:stack/dataviz/": "2026-11-08T10:59:00.000Z" });
  markReads(tracked, repoRoots, [...Object.entries(found).map(([path, ts]) => ({ path, ts })), { path: "@code/.agents/skills/stack/python/SKILL.md", ts: "2026-11-10T00:00:00.000Z" }]);
  assert.deepEqual(tracked.map(skill => skill.lastRead), ["2026-11-09T09:06:00.000Z", "2026-11-08T10:59:00.000Z", "2026-11-10T00:00:00.000Z"]);
});
