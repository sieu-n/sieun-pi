// Guards the 10-20 01:17Z wiki dream move 13377e9a. Job sub-6091ecc5 of clean-room trial chat 01a155fc (readme preview run4) saved a
// global memory that a server the owner keeps running needs RefuseManualStop, from the trial task's "leave it running", which the owner never
// said. The d4 job read it as a new memory, moved it into skills/board/SKILL.md and deleted it
// (~/work/archived-job-cleanup/trial-memory/run4-global-memory.md). The precheck now names a memory a trial session wrote as trial output
// and leaves it out of the new and move lists, while a memory an outside session wrote, or one a trial only read, stays movable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureDream, trialWrites, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const NOW = Date.parse("2026-10-20T01:08:00Z");
const TRIAL = "01a155fc-8ff3-741a-8d3b-906bcbd33491";
const FIXTURE = "01a15600-0000-7000-8000-000000000001";
const OUTSIDE = "01a15500-0000-7000-8000-000000000002";
const RUN4 = {
  id: "a_server_the_owner_asked_to_keep_running_needs_a_real_user_unit_with_refusemanua", kind: "memory", scope: "global", path: "systemd",
  title: "A server the owner asked to keep running needs a real user unit with RefuseManualStop, since leftover sweeps stop transient ones",
  content: "Seen 2026-10-19 on us-metal02. ... RefuseManualStop=yes ...", created_at: "2026-10-19T22:46:55.447Z", updated_at: "2026-10-19T22:46:55.447Z",
};
const FIXTURE_EDIT = {
  id: "auto_sns_agent_fixture_edit", kind: "memory", scope: "global", path: "auto-sns-agent/dev-env", title: "auto-sns-agent: an older fact a fixture rewrote",
  content: "x", created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-19T23:10:00Z",
};
const DIGEST_ONLY = {
  id: "auto_sns_agent_named_in_a_trial_digest", kind: "memory", scope: "global", path: "auto-sns-agent/git", title: "auto-sns-agent: a fact a trial only read",
  content: "y", created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z",
};
const OUTSIDE_FACT = {
  id: "auto_sns_agent_outside_fact", kind: "memory", scope: "global", path: "auto-sns-agent/ci", title: "auto-sns-agent: a fact an outside job saved",
  content: "z", created_at: "2026-10-19T23:30:00Z", updated_at: "2026-10-19T23:30:00Z",
};
const MEMORIES = [RUN4, FIXTURE_EDIT, DIGEST_ONLY, OUTSIDE_FACT];

const call = (at: string, code: string): string => JSON.stringify({ type: "message", timestamp: at,
  message: { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "ipython", arguments: { code } }] } });
const lines = (...rows: string[]): string => rows.join("\n") + "\n";

/** A Prime agent folder with run4's job transcript, a filed fixture, a trial digest that only names a memory, and an outside session. */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dream-trial-"));
  mkdirSync(join(dir, "browser-chat"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "browser-chat", "clean-room-chats.json"), JSON.stringify({ ids: [TRIAL] }));
  writeFileSync(join(dir, "browser-chat", "clean-room-harness.json"), JSON.stringify({ trials: { [FIXTURE]: { name: "fixture", dir: "/run/harness" } }, names: {} }));
  const job = join(dir, "session-artifacts", TRIAL, "sub-6091ecc5");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "01a15648-a280-75da-a675-e46a9754b81a.jsonl"), lines(
    call("2026-10-19T22:46:40Z", "print(inspect.signature(rlm.harness.create_memory))"),
    call("2026-10-19T22:46:55.411Z", `e=rlm.harness.create_memory(${JSON.stringify(RUN4.title)},\n${JSON.stringify(RUN4.content)}, path="systemd", global_=True)\nprint(e.id)`),
  ));
  writeFileSync(join(dir, "sessions", `${TRIAL}.jsonl`), lines(
    JSON.stringify({ type: "message", message: { role: "custom", content: [{ type: "text", text: `[harness-digest] [global:${DIGEST_ONLY.id}] ${DIGEST_ONLY.title}; create_memory is the call contract` }] } }),
    call("2026-10-19T22:40:00Z", `print(rlm.get_harness_state()["entries"]["memory"]["${DIGEST_ONLY.id}"])`),
  ));
  writeFileSync(join(dir, "sessions", `${FIXTURE}.jsonl`), lines(call("2026-10-19T23:10:00Z", `rlm.harness.update_memory("${FIXTURE_EDIT.id}", content="x", global_=True)`)));
  writeFileSync(join(dir, "sessions", `${OUTSIDE}.jsonl`), lines(call("2026-10-19T23:30:00Z", `rlm.harness.create_memory(${JSON.stringify(OUTSIDE_FACT.title)}, "z", global_=True)`)));
  return dir;
}

function deps(dir: string): DreamDeps {
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }),
    harness: JSON.stringify({ entries: { memory: Object.fromEntries(MEMORIES.map(entry => [entry.id, entry])) }, refinements: [] }),
    ledger: JSON.stringify({ classes: {} }),
  };
  return {
    now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: dir },
    readText: async path => files[path]!,
    exec: async file => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } });
      if (file === "journalctl") return `${NOW / 1000 - 60} us-metal02 systemd[1]: Starting wiki-box-commit.service\n${NOW / 1000 - 30} us-metal02 systemd[1]: Finished wiki-box-commit.service\n`;
      return "";
    },
  };
}

test("a memory a trial chat's job or a filed fixture wrote is trial output; one a trial only read or an outside session wrote is not", async () => {
  const dir = agentDir();
  try {
    const found = await trialWrites(MEMORIES, dir);
    assert.deepEqual(Object.fromEntries(found), { [RUN4.id]: "01a15648-a280-75da-a675-e46a9754b81a", [FIXTURE_EDIT.id]: FIXTURE });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the precheck names run4's memory as trial output and lists it for no move, and the outside repo fact still moves (10-20 01:08Z)", async () => {
  const dir = agentDir();
  try {
    const result = await measureDream(deps(dir), [{ at: Date.parse("2026-10-19T22:00:00Z"), verdict: "met" } as never]);
    assert.equal(result.metrics.source_errors, 0);
    const flagged = result.flagged ?? [];
    const kinds = (id: string): string[] => flagged.filter(slice => slice.item === id).map(slice => slice.kind);
    assert.deepEqual(kinds(RUN4.id), ["trial_memory"], "on 10-20 it was listed as new since last run");
    assert.match(flagged.find(slice => slice.item === RUN4.id)!.excerpt, /clean-room trial session 01a15648-a280-75da-a675-e46a9754b81a.*move none of it into a skill/);
    assert.deepEqual(kinds(FIXTURE_EDIT.id), ["trial_memory"]);
    assert.deepEqual(kinds(OUTSIDE_FACT.id), ["memory"]);
    assert.deepEqual(kinds(DIGEST_ONLY.id), ["memory"], "a repo fact a trial only read is still moved");
    assert.equal(result.info.trial_memories, 2);
    assert.equal(result.info.new_memories, 1);
    assert.equal(result.info.repo_fact_memories, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a box where no trial ran reads no index and keeps every memory movable", async () => {
  assert.equal((await trialWrites(MEMORIES, "/nonexistent-agent-dir")).size, 0);
});

test("an index that does not parse fails the harness input, so no move is listed from an unchecked store", async () => {
  const dir = agentDir();
  try {
    writeFileSync(join(dir, "browser-chat", "clean-room-chats.json"), "{");
    const result = await measureDream(deps(dir), []);
    assert.ok((result.flagged ?? []).some(slice => slice.kind === "source_error" && slice.item === "harness_state.json"));
    assert.equal((result.flagged ?? []).filter(slice => slice.kind === "memory" || slice.kind === "trial_memory").length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
