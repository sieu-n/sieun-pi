/**
 * `scripts/duties/owner-style.ts`:
 * 1. STYLE_WORDS finds the owner's real style corrections of 11-20 and skips his feature asks of the same day.
 * 2. Candidates come only from owner posts of real rooms in the window, never from a test or archived room or an agent's post.
 * 3. A note counts as shared when the skill holds its skill words or the role text holds its role words.
 * 4. The role text is the one pi-host renders, so the p97 options rule shows in it, as e3bf6439 reworded it on 11-22.
 * 5. A blind ask that got no model answer is not measured: the share is over the notes whose set got an answer, a run where none did keeps
 *    the share of the newest run that measured one, and an answered ask that breaks a rule still fails. blind-replies.mjs marks such an ask
 *    itself and sends no ask after it.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { lastMeasured } from "../../scripts/duties/agent-memory.ts";
import { askCount, askLines, blindCount, ownerPosts, roleText, shared, STYLE_WORDS, unansweredAsk, type AskLine, type BlindRow, type Note } from "../../scripts/duties/owner-style.ts";

const dir = mkdtempSync(join(tmpdir(), "owner-style-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("STYLE_WORDS finds the owner's style corrections and skips his feature asks", () => {
  for (const text of [
    "Superhuman's \"remind me if no reply\" intereseting can you elaborate? 이런거 말할떄는 가장 흥미로운거 하나는 제대로 설명해야지^^",
    "이런거 답변할때 hierarchical bullet point, checkmark 등 feature를 활용해서 답변해.",
    "first message still feels like too much slop. what would be ideal shape",
    "no this is not Chat. this is Slack.",
    "- 체크도 남발하지 마 제발 the final outcome should ALWAYS act like a Slack thread",
  ]) assert.ok(STYLE_WORDS.test(text), text);
  for (const text of [
    "Later should not be a separate tab. \n\nit should be a row in the Messages view instead.",
    "in app browser kinda weird",
    "SOLO는 뭔데",
    "add a \"Bookmark\" (i.e. save) message feature, and some kind of keep unread(?) or remind me(?) feature? 잘 풀어내봐",
  ]) assert.ok(!STYLE_WORDS.test(text), text);
});

test("candidates are owner posts of real rooms in the window", () => {
  const data = join(dir, "chat");
  mkdirSync(join(data, "rooms"), { recursive: true });
  writeFileSync(join(data, "rooms.json"), JSON.stringify({ rooms: [{ id: "ch_real" }, { id: "ch_walk", test: true }, { id: "ch_old", archived: true }] }));
  const post = (id: string, author: string, at: number) => JSON.stringify({ t: "post", post: { id, author, at, text: "too much slop" } });
  writeFileSync(join(data, "rooms", "ch_real.jsonl"), [post("p1", "owner", 2_000), post("p2", "ag_vent", 2_000), post("p3", "owner", 500), "{bad", JSON.stringify({ t: "set", post: "p1" })].join("\n"));
  writeFileSync(join(data, "rooms", "ch_walk.jsonl"), post("p1", "owner", 2_000));
  writeFileSync(join(data, "rooms", "ch_old.jsonl"), post("p1", "owner", 2_000));
  assert.deepEqual(ownerPosts(data, 1_000).map(p => `${p.room}/${p.id}`), ["ch_real/p1"]);
});

test("a note is shared when the skill or the role text holds its words", () => {
  const note: Note = { id: "options", posts: [], at: "2026-11-20T06:43:00Z", words: "", rule: "", skill: ["most interesting one"], role: ["when you list options"] };
  assert.deepEqual(shared(note, "explain the most interesting one", "nothing"), { skill: true, role: false });
  assert.deepEqual(shared(note, "nothing", "When you list options, pick"), { skill: false, role: true });
  assert.deepEqual(shared({ ...note, skill: [], role: undefined }, "most interesting one", "when you list options"), { skill: false, role: false });
});

test("the role text is what pi-host renders, with the p97 options rule and the shared-text routing", async () => {
  const profile = resolve(fileURLToPath(import.meta.url), "../../../../../packages/pi-host/src/durable/agent-profile.ts");
  const text = await roleText(profile);
  assert.match(text, /When you list options, open with your pick and its reason[\s\S]*concrete example/);
  assert.match(text, /A correction of how you wrote a post counts too/);
  assert.match(text, /yours to put into the sw-factory skill/);
});

test("a blind ask with no reply in its wait is not measured, and an answered ask that breaks a rule still fails", () => {
  const good: AskLine = { ask: "a", expect: "line", replies: ["v26."], pass: true };
  const bad: AskLine = { ask: "b", expect: "reply", replies: ["| a | b |\n|---|---|"], pass: false };
  const waited: AskLine = { ask: "c", expect: "reply", replies: [], pass: false, unanswered: true };
  const old: AskLine = { ask: "d", expect: "list", replies: [], pass: false };
  const thanks: AskLine = { ask: "ok thanks", expect: "reaction", replies: [], pass: true };
  assert.deepEqual([good, bad, waited, old, thanks].map(unansweredAsk), [false, false, true, true, false]);
  assert.deepEqual(askCount([good, bad, waited, old, thanks]), { of: 3, passed: 2, unmeasured: 2 });
  assert.deepEqual(askCount([waited, old]), { of: 0, passed: 0, unmeasured: 2 });
  assert.deepEqual(askLines(`${JSON.stringify(good)}\n${JSON.stringify(waited)}\n${JSON.stringify({ room: "ch_1", passed: 1, of: 1, unmeasured: 1, pass: true })}\n`), [good, waited]);
});

test("blind follow is over the notes whose set got an answer, and two notes on one set count its unanswered asks once", () => {
  const rows: BlindRow[] = [
    { note: "slack-not-chat", set: "default", out: "default.jsonl", of: 0, passed: 0, unmeasured: 3 },
    { note: "plain-words", set: "default", out: "default.jsonl", of: 0, passed: 0, unmeasured: 3 },
    { note: "natural", set: "natural", out: "natural.jsonl", of: 2, passed: 2, unmeasured: 0 },
    { note: "nested-bullets", set: "lists", out: "lists.jsonl", of: 1, passed: 1, unmeasured: 1 },
    { note: "options", set: "options", out: "options.jsonl", of: 1, passed: 0, unmeasured: 0 },
    { note: "checklist-then-edit", set: "checklist", out: "checklist.jsonl", error: "the run wrote no summary" },
  ];
  assert.deepEqual(blindCount(rows), { measured: 4, passed: 2, unmeasured: 2, asksUnmeasured: 4 });
  assert.deepEqual(blindCount(rows.slice(0, 2)), { measured: 0, passed: 0, unmeasured: 2, asksUnmeasured: 3 });
  assert.deepEqual(blindCount([]), { measured: 0, passed: 0, unmeasured: 0, asksUnmeasured: 0 });
});

test("a run where no blind set got an answer keeps the share of the newest run that measured one, read from its reply files", () => {
  // The rows a detail file held before the `unmeasured` field, as the 06:45 KST run of 11-23 stored them: "0 of 3 asks pass" with no reply.
  const none = { ask: "x", expect: "reply", replies: [], pass: false };
  const files: Record<string, AskLine[]> = {
    "starved/default.jsonl": [none, none, none],
    "starved/natural.jsonl": [{ ask: "n", expect: "natural", replies: ["I'd adapt it."], pass: true }, { ask: "m", expect: "natural", replies: ["Retries work."], pass: true }],
    "starved/options.jsonl": [none],
    "good/default.jsonl": [{ ask: "x", expect: "reply", replies: ["Yes."], pass: true }],
    "good/lists.jsonl": [{ ask: "y", expect: "list", replies: ["# Status"], pass: false }],
  };
  const details: Record<string, unknown> = {
    "starved.json": { blind: [{ note: "slack-not-chat", set: "default", out: "starved/default.jsonl", pass: false, passed: 0, of: 3 }, { note: "options", set: "options", out: "starved/options.jsonl", pass: false, passed: 0, of: 1 }] },
    "mixed.json": { blind: [{ note: "slack-not-chat", set: "default", out: "starved/default.jsonl", pass: false, passed: 0, of: 3 }, { note: "natural", set: "natural", out: "starved/natural.jsonl", pass: true, passed: 2, of: 2 }] },
    "good.json": { blind: [{ note: "slack-not-chat", set: "default", out: "good/default.jsonl", pass: true, passed: 1, of: 1 }, { note: "nested-bullets", set: "lists", out: "good/lists.jsonl", pass: false, passed: 0, of: 1 }] },
    "now.json": { blind: [{ note: "options", set: "options", out: "gone.jsonl", of: 0, passed: 0, unmeasured: 1 }] },
    "no-blind.json": {},
  };
  const read = (file: string): unknown => {
    if (!(file in details)) throw new Error(`ENOENT ${file}`);
    return details[file];
  };
  const count = (detail: unknown): { part: number; whole: number } => {
    const blind = blindCount((detail as { blind?: BlindRow[] } | null)?.blind ?? [], out => files[out]);
    return { part: blind.passed, whole: blind.measured };
  };
  assert.deepEqual(count(details["starved.json"]), { part: 0, whole: 0 });
  assert.deepEqual(count(details["mixed.json"]), { part: 1, whole: 1 });
  const runs = [{ at: 1, detail: "good.json" }, { at: 4, detail: "starved.json" }, { at: 5, detail: "now.json" }, { at: 6, detail: "gone.json" }, { at: 7, detail: "no-blind.json" }, { at: 8 }];
  assert.deepEqual(lastMeasured(runs, read, count), { pct: 50, at: 1 });
  assert.deepEqual(lastMeasured([...runs, { at: 3, detail: "mixed.json" }], read, count), { pct: 100, at: 3 });
  assert.deepEqual(lastMeasured([{ at: 4, detail: "starved.json" }], read, count), null);
});

test("blind-replies.mjs marks an ask with no post and no reaction unanswered, sends no ask after it and exits 2", async () => {
  const sends: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const path = `${request.method} ${request.url}`;
      const answer = path === "POST /api/agents" ? { id: "ag_blind", room: "dm_blind" }
        : path === "POST /api/rooms" ? { id: "ch_blind" }
        : path === "POST /api/c/ch_blind/send" ? (sends.push(String(JSON.parse(body).text)), { item: { id: `p${sends.length}`, seq: sends.length } })
        : path === "GET /api/c/ch_blind/replies/p1" ? { root: { id: "p1", reactions: [] }, items: [] }
        : undefined;
      response.writeHead(answer ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(answer ?? { error: path }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  after(() => server.close());
  const out = join(dir, "starved.jsonl");
  const script = resolve(fileURLToPath(import.meta.url), "../../../scripts/blind-replies.mjs");
  const child = spawn(process.execPath, [script, "--set", "lists", "--no-reaction", "--out", out, "--server", `http://127.0.0.1:${(server.address() as AddressInfo).port}`, "--first-ms", "300", "--poll-ms", "50"], { stdio: "ignore" });
  const code = await new Promise<number | null>(done => child.on("close", done));
  assert.equal(code, 2);
  assert.equal(sends.length, 1);
  const text = readFileSync(out, "utf8");
  const lines = askLines(text);
  assert.deepEqual(lines.map(line => [line.expect, line.unanswered, line.pass]), [["list", true, false], ["line", true, false]]);
  assert.deepEqual(askCount(lines), { of: 0, passed: 0, unmeasured: 2 });
  const summary = JSON.parse(text.trim().split("\n").at(-1)!) as Record<string, unknown>;
  assert.deepEqual({ passed: summary.passed, of: summary.of, unmeasured: summary.unmeasured, pass: summary.pass }, { passed: 0, of: 0, unmeasured: 2, pass: false });
});
