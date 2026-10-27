// 10-20 us-metal02: clean-room run8 (job-cancel-cleanup) was judged void at 18:01Z because its chat's file held Prime's provider usage
// resume, "<provider_quota_resumed> ... retry.provider.waitForUsage.pauseUntilReset ...", as a user turn at 15:44:44.975Z. Prime writes that
// turn itself after a provider_quota_park entry in the same file, and the judges counted it as a person stepping in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const RESUME = "<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset; this resume is automatic " +
  "(retry.provider.waitForUsage.pauseUntilReset). Continue the interrupted task from where it stopped.\n</provider_quota_resumed>";

test("a quota resume Prime wrote after its own park is no owner turn, and the same words with no park or any other typed turn still void the run", async t => {
  const home = mkdtempSync(join(tmpdir(), "quota-resume-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { jobCancelCleanup, TASK } = await import("../scripts/clean-room/job-cancel-cleanup.ts");
  const start = Date.parse("2026-10-20T15:26:27.667Z");
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const user = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "user", content: [{ type: "text", text }] } });
  const park = (minutes: number) => ({ type: "custom", customType: "provider_quota_park", timestamp: at(minutes), data: { resumeAt: at(minutes + 5), parkCount: 0, provider: "anthropic" } });
  const judge = async (name: string, entries: object[]) => {
    const chat = `01a159eb-a0e3-7268-b8c3-00000000000${name}`;
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [user(0, TASK), ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const run = join(home, "runs", name);
    mkdirSync(run, { recursive: true });
    const { verdict, text } = await jobCancelCleanup.evaluate(run, { scenario: "job-cancel-cleanup", chat: { id: chat, name }, fixtures: {}, sandbox: home, everyMs: 0,
      release: "test", board: "", seeds: [TASK], setupAt: start, windowStart: start });
    return { verdict, g: text.split("\n").find(line => line.startsWith("- g ")) ?? "" };
  };

  const runtime = await judge("1", [park(10), user(18, RESUME)]);
  assert.match(runtime.g, /^- g met/, runtime.g);
  assert.notEqual(runtime.verdict, "void");

  const twice = await judge("2", [park(10), user(18, RESUME), user(19, RESUME)]);
  assert.match(twice.g, /^- g not met/, "one park answers one resume; a second copy is typed");
  assert.equal(twice.verdict, "void");

  const typed = await judge("3", [user(18, RESUME)]);
  assert.match(typed.g, /^- g not met/, "the resume's words with no park before them are a typed turn");
  assert.equal(typed.verdict, "void");

  const angle = await judge("4", [park(10), user(18, "<provider_quota_resumed>\nplease also check the mac\n</provider_quota_resumed>")]);
  assert.match(angle.g, /^- g not met/, "other words in the same tags are a typed turn");

  const owner = await judge("5", [park(10), user(18, RESUME), user(30, "stop that job and run it on the mac instead")]);
  assert.match(owner.g, /^- g not met.*stop that job/, owner.g);
  assert.equal(owner.verdict, "void");
});
