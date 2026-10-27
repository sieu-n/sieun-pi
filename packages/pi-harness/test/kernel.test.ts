import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";

for (const key of Object.keys(process.env)) if (key.startsWith("RLM_") || key === "PRIME_AGENT_CODING_AGENT_DIR") delete process.env[key];
const root = mkdtempSync(join(tmpdir(), "pi-harness-kernel-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const { fauxProvider } = await import("@sieun-pi/pi-testkit/faux");
const { openWithSkills, testPython } = await import("@sieun-pi/pi-rlm/test-helpers");
const { default: piRlm } = await import("@sieun-pi/pi-rlm");
const { createHarnessExtension } = await import("../src/pi/index.ts");
const { globalHarnessDir, readState } = await import("../src/core/store.ts");
const { PLANNER_PROMPT } = await import("../src/core/prompts.ts");

before(async () => {
  await testPython();
});
after(() => rmSync(root, { recursive: true, force: true }));

type Ctx = { systemPrompt?: string; messages: { role: string; content: unknown }[] };
const plannerMark = JSON.stringify(PLANNER_PROMPT.slice(0, 60)).slice(1, -1);

test("rlm.harness writes both stores from a kernel cell, and refine.run() from the kernel runs a self refine that the agent resumes on", async () => {
  const faux = fauxProvider();
  const script: ((c: Ctx) => AssistantMessage)[] = [
    () => fauxAssistantMessage(fauxToolCall("ipython", { code: "rlm.harness.create_memory('Kernel local', 'written from the kernel')\nrlm.harness.create_memory('Kernel global', 'global from the kernel', global_=True)\nprint(rlm.harness.file_path)" })),
    () => fauxAssistantMessage(fauxToolCall("ipython", { code: "print(await refine.status())\nprint(await refine.run('remember the kernel check'))" })),
    () => fauxAssistantMessage([fauxText("turn done")]),
    c => fauxAssistantMessage([fauxText(JSON.stringify(c.messages).includes("[self-refinement]") ? "resumed with notice" : "resumed without notice")]),
  ];
  const seen: string[] = [];
  const respond = (c: Ctx) => {
    const text = (c.systemPrompt ?? "") + JSON.stringify(c.messages);
    if (text.includes(plannerMark)) {
      seen.push("planner");
      return fauxAssistantMessage(JSON.stringify({ summary: "kernel asked", edits: [{ action: "create", kind: "memory", id: "from_refine", title: "From refine", content: "refine.run worked" }] }));
    }
    seen.push("turn");
    return (script.shift() ?? (() => fauxAssistantMessage([fauxText("idle")])))(c);
  };
  faux.core.setResponses(Array.from({ length: 30 }, () => respond as never));
  const rt = await openWithSkills({ root, provider: faux, extensionFactories: [piRlm, createHarnessExtension()] });
  try {
    await rt.session.prompt("check the harness from the kernel");
    for (let i = 0; i < 300 && script.length > 0; i++) await new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < 100 && rt.session.isStreaming; i++) await new Promise(r => setTimeout(r, 50));
    const tools = rt.session.messages.filter(m => m.role === "toolResult").map(m => JSON.stringify((m as { content: unknown }).content));
    assert.match(tools[1] ?? "", /scheduled.*True/, "refine.run answered scheduled");
    const id = rt.session.sessionManager.getSessionId();
    const local = readState(join(root, "agent", "session-artifacts", id, "harness"), "local");
    assert.ok(Object.values(local.entries.memory).some(e => e.content === "written from the kernel"), "the kernel wrote the session's local store");
    assert.ok(local.entries.memory.from_refine, "the self refine wrote the local store");
    const global = readState(globalHarnessDir(), "global");
    assert.ok(Object.values(global.entries.memory).some(e => e.content === "global from the kernel"), "the kernel and pi-harness agree on the global store path");
    const last = rt.session.messages.filter(m => m.role === "assistant").at(-1) as { content: { text?: string }[] };
    assert.equal(last.content[0]?.text, "resumed with notice");
    assert.ok(seen.includes("planner"));
  } finally {
    await rt.dispose?.();
  }
});
