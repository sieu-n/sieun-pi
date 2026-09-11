import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as standing from "../components/virev/ext-impl/virev/standing-rules.mjs";
import * as lint from "../components/virev/ext-impl/virev/lint.mjs";

const implDir = fileURLToPath(new URL("../components/virev/ext-impl/virev", import.meta.url));
const bundledDoc = readFileSync(new URL("../skills/unslop/SKILL.md", import.meta.url), "utf8").trim();
const temp = mkdtempSync(join(tmpdir(), "virev-standing-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
test.beforeEach(() => {
  standing.setBaseDir(implDir);
  standing.onSessionStart();
});

test("loads the full bundled document from the canonical source tree", () => {
  assert.equal(standing.loadDoc(), bundledDoc);
  const linked = join(temp, "linked-impl");
  symlinkSync(implDir, linked, "dir");
  standing.setBaseDir(linked);
  assert.equal(standing.loadDoc(), bundledDoc);
});

test("keeps a document override", () => {
  const path = join(temp, "override.md");
  writeFileSync(path, "Override writing rules.\n");
  const previous = process.env.VIREV_UNSLOP_DOC;
  process.env.VIREV_UNSLOP_DOC = path;
  try {
    standing.setBaseDir(implDir);
    const prompt = standing.onBeforeAgentStart({ systemPrompt: "HOST" }).systemPrompt;
    assert.ok(prompt.includes("Override writing rules."));
    assert.ok(!prompt.includes(bundledDoc));
  } finally {
    if (previous === undefined) delete process.env.VIREV_UNSLOP_DOC;
    else process.env.VIREV_UNSLOP_DOC = previous;
  }
});

test("adds both rule documents once to stable system context", () => {
  const event = { systemPrompt: "HOST PROMPT" };
  const result = standing.onBeforeAgentStart(event);
  assert.ok(result.systemPrompt.startsWith("HOST PROMPT\n\n"));
  assert.ok(result.systemPrompt.includes(standing.MARKER));
  assert.ok(result.systemPrompt.includes(standing.DOCUMENT_MARKER));
  assert.ok(result.systemPrompt.includes(bundledDoc));
  assert.equal(standing.onBeforeAgentStart({ systemPrompt: result.systemPrompt }), undefined);
  assert.deepEqual(event, { systemPrompt: "HOST PROMPT" });
});

test("existing short rules do not suppress the full writing document", () => {
  const systemPrompt = "HOST\n" + standing.loadRules();
  const result = standing.onBeforeAgentStart({ systemPrompt });
  assert.ok(result.systemPrompt.startsWith(systemPrompt));
  assert.equal(result.systemPrompt.split(standing.MARKER).length, 2);
  assert.equal(result.systemPrompt.split(standing.DOCUMENT_MARKER).length, 2);
  assert.ok(result.systemPrompt.includes(bundledDoc));
});

test("same system prompt survives turns, lint findings, and a new session", () => {
  const event = { systemPrompt: "HOST" };
  const first = standing.onBeforeAgentStart(event);
  lint.onMessageEnd({ message: { role: "assistant", content: [{ type: "text", text: "A reply \u2014 with a dash." }] } });
  assert.deepEqual(standing.onBeforeAgentStart(event), first);
  standing.onSessionStart();
  assert.deepEqual(standing.onBeforeAgentStart(event), first);
  standing.setBaseDir(implDir);
  assert.deepEqual(standing.onBeforeAgentStart(event), first);
});

test("does not export request-time history mutation or obsolete nudge state", () => {
  assert.equal("onContext" in standing, false);
  assert.equal("recentHardHits" in lint, false);
  assert.equal("clearRecentHardHits" in lint, false);
});

test("lint reports violations without changing replies or system instructions", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "> Source \u2014 a quoted dash.\n\nMy reply \u2014 has a dash." }] };
  const original = structuredClone(message);
  const statuses = [];
  const prompt = standing.onBeforeAgentStart({ systemPrompt: "HOST" });
  assert.equal(lint.onMessageEnd({ message }, { ui: { setStatus: (...args) => statuses.push(args) } }), undefined);
  assert.deepEqual(message, original);
  assert.equal(statuses[0][0], "virev-lint");
  assert.match(statuses[0][1], /unslop/);
  assert.deepEqual(standing.onBeforeAgentStart({ systemPrompt: "HOST" }), prompt);
});

test("disabled standing rules leave the host prompt unchanged", () => {
  const previous = process.env.VIREV_STANDING_RULES;
  process.env.VIREV_STANDING_RULES = "off";
  try {
    assert.equal(standing.onBeforeAgentStart({ systemPrompt: "HOST" }), undefined);
  } finally {
    if (previous === undefined) delete process.env.VIREV_STANDING_RULES;
    else process.env.VIREV_STANDING_RULES = previous;
  }
});
