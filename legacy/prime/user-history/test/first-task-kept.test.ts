import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { firstTask, parseSummaries, sessionTitle } from "../src/chat-catalog.ts";
import { applyRosterUpdate } from "../src/session-peer.ts";

const brief = `# Fix the d7 minute\n\n${"Read the profile and cut the cause. ".repeat(600)}`;
const skill = `<skill name="poteto-mode" location="/x/SKILL.md">\n${"rules ".repeat(3000)}\n</skill>\n\ncheck the Mac daemon`;
const row = (sessionId: string, firstMessage: string) => ({ sessionId, cwd: "/home/sieun", firstMessage }) as unknown as SessionSummary;

test("a listed row keeps its first message cut to what the task and title read, and both read the same", () => {
  const [long, skilled] = parseSummaries({ sessions: [row("a", brief), row("b", skill)] });
  assert.equal(long!.firstMessage?.length, 2000);
  assert.equal(firstTask(long!), firstTask(row("a", brief)).slice(0, 2000));
  assert.equal(sessionTitle(long!), sessionTitle(row("a", brief)));
  assert.equal(skilled!.firstMessage, "check the Mac daemon");
  assert.equal(firstTask(skilled!), firstTask(row("b", skill)));
  assert.equal(sessionTitle(skilled!), sessionTitle(row("b", skill)));
});

test("a short first message keeps its row object", () => {
  const short = row("c", "check the Mac daemon");
  assert.equal(parseSummaries({ sessions: [short] })[0], short);
});

test("a roster update keeps its row's first message cut the same way", () => {
  const rows = new Map<string, SessionSummary>();
  applyRosterUpdate(rows, new Map(), { changed: [{ agentId: "a", summary: row("a", brief) }] });
  assert.equal(rows.get("id:a")!.firstMessage?.length, 2000);
});
