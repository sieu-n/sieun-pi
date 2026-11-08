// On 11-08 two wiki dream jobs built skill-text-only objects (6353da5770, 7229e743) and asked the chat for a probe slot, because this
// rule sent every object to Fable. The VP of CI said a skill-text-only change needs no probe slot and lands with land-object.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyJobBrief } from "../src/chat-duty-job.ts";

test("a duty brief lands a skill or doc text object with land-object.mjs and sends only code to the chat for a probe slot", () => {
  const chat = { id: "01a14210-4e7d-72c3-aa67-e3d476f4e728", name: "Fixture", cwd: "/repo", board: "/tmp/board.json" };
  const duty = { name: "d", ownerWords: "w", goal: "g", metrics: [{ key: "ok", label: "ok", op: ">=", target: 1 }] };
  const brief = dutyJobBrief({ duty, chat, job: "j", at: 0, measure: "m", findings: "f" } as Parameters<typeof dutyJobBrief>[0]);
  const rule = brief.split("\n").find(line => line.includes("--object-only"));
  assert.ok(rule, "the brief carries the object commit rule");
  assert.match(rule, /only skill or doc text \(`\.agents\/skills\/\*\*`, `\*\.md` references\) needs no probe slot/);
  assert.match(rule, /land it yourself with `node scripts\/repo\/agent\/land-object\.mjs <sha>` from ~\/Documents\/Github\/auto-sns-agent/);
  assert.match(rule, /Send a code commit to the chat, which asks Fable for a probe slot/);
});
