import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";
import { ownerCadenceRefusal } from "../src/owner-history.ts";

// The owner, AI harness chat, 10-14 09:17Z: "setup a 60min cadence duty" (message id mv7w4mb3, his message's timestamp in base 36). c66 keeps an
// agent's duties daily, so add.ts takes every 60 only with his verbatim words and that message's id, the way correction_add takes owner words.

const component = join(import.meta.dirname, "..");
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const ASKED_AT = 1791969089007;
const WORDS = "setup a 60min cadence duty";
const definition = (minutes = 60) => ({ name: "Mac stays usable", ownerWords: WORDS, goal: "The harness side keeps the Mac usable.", onMiss: "Start a fix job.",
  metrics: [{ key: "on_target_pct_1h", label: "Share of minutes on target", op: ">=", target: 100 }], precheck: { command: ["node", "-e", "0"], cwd: "." },
  schedule: { kind: "every", minutes } });

async function setup(): Promise<{ dir: string; sessions: string }> {
  const dir = await mkdtemp(join(tmpdir(), "duty-owner-cadence-"));
  const sessions = join(dir, "sessions");
  await promisify(execFile)("mkdir", ["-p", sessions]);
  const line = (text: string, at: number, role = "user") => JSON.stringify({ type: "message", id: String(at), message: { role, content: [{ type: "text", text }], timestamp: at } });
  await writeFile(join(sessions, `${CHAT}.jsonl`), [line("look it's you and ops guys responsibility that this machine is usable.", ASKED_AT - 50_000),
    line(WORDS, ASKED_AT), line("Setting up the 60min cadence duty now.", ASKED_AT + 5_000, "assistant")].join("\n") + "\n");
  await writeFile(join(dir, "labels.json"), JSON.stringify({ tags: [], threads: {} }));
  return { dir, sessions };
}

async function add(dir: string, sessions: string, value: unknown, flags: string[] = []): Promise<{ code: number; out: string }> {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.duty.json`);
  await writeFile(file, JSON.stringify(value));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/add.ts", CHAT, file, "--data-dir", dir, "--sessions-dir", sessions, ...flags], { cwd: component });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stderr ?? "" };
  }
}

test("add.ts: the owner override with his words and message id adds an every 60 duty and says whose ask it is", async () => {
  const { dir, sessions } = await setup();
  const added = await add(dir, sessions, definition(), ["--owner-words", WORDS, "--owner-message", "mv7w4mb3"]);
  assert.equal(added.code, 0, added.out);
  assert.equal(added.out.trim(), `added d1 "Mac stays usable" in ${CHAT} every 60 min, priority high, the owner's ask mv7w4mb3`);
  assert.deepEqual((await new DutyStore(dir).list(CHAT)).map(duty => duty.schedule), [{ kind: "every", minutes: 60 }]);
});

test("add.ts: the plain agent path still refuses every 60 with c66 and names the override", async () => {
  const { dir, sessions } = await setup();
  const refused = await add(dir, sessions, definition());
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^c66: the owner keeps duties daily/);
  assert.match(refused.out, /pass his words with --owner-words and his message id with --owner-message/);
  assert.equal((await new DutyStore(dir).list(CHAT)).length, 0, "a refused duty is not stored");
});

test("add.ts: the override without his words or without the message id is refused", async () => {
  const { dir, sessions } = await setup();
  const noWords = await add(dir, sessions, definition(), ["--owner-message", "mv7w4mb3"]);
  assert.deepEqual([noWords.code, noWords.out.trim()], [1, "The owner override needs both his verbatim words and his message id; --owner-words is missing."]);
  const noId = await add(dir, sessions, definition(), ["--owner-words", WORDS]);
  assert.deepEqual([noId.code, noId.out.trim()], [1, "The owner override needs both his verbatim words and his message id; --owner-message is missing."]);
  assert.equal((await new DutyStore(dir).list(CHAT)).length, 0);
});

test("ownerCadenceRefusal: the id must name an owner message, the words must be in it, and they must name the cadence", () => {
  const owner = [{ text: "look it's you and ops guys responsibility that this machine is usable.", at: ASKED_AT - 50_000 }, { text: WORDS, at: ASKED_AT }];
  const every = (minutes: number) => ({ kind: "every" as const, minutes });
  assert.equal(ownerCadenceRefusal(every(60), { words: WORDS, messageId: "mv7w4mb3" }, owner), null);
  assert.equal(ownerCadenceRefusal(every(60), { words: "60min cadence", messageId: "mv7w4mb3" }, owner), null, "a part of his message is his words");
  const first = (ASKED_AT - 50_000).toString(36);
  assert.equal(ownerCadenceRefusal(every(60), { words: WORDS, messageId: first }, owner), `"${WORDS}" is not in the owner's message ${first}. Quote him exactly.`);
  assert.match(ownerCadenceRefusal(every(60), { words: WORDS, messageId: "zzzzzzzz" }, owner)!, /^No owner message zzzzzzzz in this chat/);
  assert.match(ownerCadenceRefusal(every(60), { words: "setup a 5min cadence duty", messageId: "mv7w4mb3" }, owner)!, /is not in the owner's message/);
  assert.match(ownerCadenceRefusal(every(30), { words: WORDS, messageId: "mv7w4mb3" }, owner)!, /does not name every 30 minutes/);
  assert.match(ownerCadenceRefusal(every(60), undefined, owner)!, /^c66: /);
  assert.equal(ownerCadenceRefusal(every(1440), undefined, owner), null, "daily needs no override");
  assert.equal(ownerCadenceRefusal({ kind: "daily", at: "06:30" }, undefined, owner), null);
});
