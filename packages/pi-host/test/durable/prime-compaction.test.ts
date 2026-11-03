/**
 * A durable thread compacts where a Prime chat on the same host does: at Prime's context window for the model minus
 * Prime's `compaction.reserveTokens`. On 11-03 Prime compacted Claude Opus 5.5 at 483,616 tokens (models.json sets its
 * window to 500K) while pi-host took pi-ai's 1M window and would have compacted at 983,616.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { durableModels } from "../../src/durable/models.ts";
import { compactionLine, primeCompaction, primeWindow, withPrimeCompaction, withPrimeWindows } from "../../src/durable/prime-compaction.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-prime-compaction-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function agentDir(name: string, files: { models?: unknown; settings?: unknown; catalog?: unknown } = {}): string {
  const at = join(dir, name);
  mkdirSync(join(at, "models"), { recursive: true });
  if (files.models) writeFileSync(join(at, "models.json"), JSON.stringify(files.models));
  if (files.settings) writeFileSync(join(at, "settings.json"), JSON.stringify(files.settings));
  if (files.catalog) writeFileSync(join(at, "models/provider-model-catalog.v1.json"), JSON.stringify({ payload: { models: files.catalog } }));
  return at;
}
const windowOf = (at: string | undefined, provider: string, id: string) => durableModels("t", { agentDir: at }).getModel(provider, id)?.contextWindow;

test("a host with no Prime files gets the windows pi-host ships, so Opus 5.5 compacts at 483,616 as on metal and the Mac", () => {
  const fresh = agentDir("fresh");
  assert.equal(windowOf(fresh, "anthropic", "claude-opus-5-5"), 500_000);
  assert.equal(windowOf(undefined, "anthropic", "claude-opus-5-5"), 500_000);
  assert.equal(windowOf(fresh, "anthropic", "claude-fable-5-1"), 500_000);
  assert.equal(windowOf(fresh, "openai-codex", "gpt-6-astra"), 1_000_000);
  assert.deepEqual(primeCompaction(fresh), {});
  const line = compactionLine(fresh, [{ provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 }]);
  assert.equal(line, "durable compaction at window - reserve 16384: anthropic/claude-opus-5-5 483616 (500000 from pi-host, pi-ai 1000000)");
});

test("the host's Prime models.json wins, its modelOverrides over its models entry, and an edit applies with no restart", () => {
  const at = agentDir("models-json", {
    models: { providers: { anthropic: { models: [{ id: "claude-opus-5-5", contextWindow: 700_000 }], modelOverrides: { "claude-sonnet-5": { contextWindow: 300_000 } } } } },
  });
  assert.deepEqual(primeWindow(at, "anthropic", "claude-opus-5-5"), { tokens: 700_000, source: "models.json" });
  assert.equal(windowOf(at, "anthropic", "claude-sonnet-5"), 300_000);
  writeFileSync(join(at, "models.json"), JSON.stringify({
    providers: { anthropic: { models: [{ id: "claude-opus-5-5", contextWindow: 700_000 }], modelOverrides: { "claude-opus-5-5": { contextWindow: 650_000 } } } },
  }));
  assert.equal(windowOf(at, "anthropic", "claude-opus-5-5"), 650_000);
  assert.equal(windowOf(at, "anthropic", "claude-sonnet-5"), 500_000, "a model the file stops naming falls back to the shipped window");
});

test("Prime's fetched catalog sets a window neither models.json nor pi-host names, as Codex's gpt-6.1-sol at 272K", () => {
  const at = agentDir("catalog", { catalog: [{ provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 272_000 }] });
  assert.equal(windowOf(at, "openai-codex", "gpt-6.1-sol"), 272_000);
  assert.equal(primeWindow(agentDir("no-catalog"), "openai-codex", "gpt-6.1-sol"), undefined, "with no Prime file pi-ai's window stays");
});

test("Prime's settings.json compaction sets the reserve, the kept tokens and enabled", () => {
  const at = agentDir("settings", { settings: { compaction: { enabled: false, reserveTokens: 30_000, keepRecentTokens: 40_000 } } });
  assert.deepEqual(withPrimeCompaction({}, at).compaction, { enabled: false, reserveTokens: 30_000, keepRecentTokens: 40_000 });
});

test("a durable thread compacts once its context passes Prime's window minus Prime's reserve, though its catalog window is far larger", { timeout: 60_000 }, async () => {
  const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };
  const at = agentDir("run", {
    models: { providers: { anthropic: { models: [{ id: MODEL.modelId, contextWindow: 3_000 }] } } },
    settings: { compaction: { reserveTokens: 1_000, keepRecentTokens: 200 } },
  });
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  assert.ok(faux.provider.getModels()[0]!.contextWindow >= 100_000, "the catalog window alone would never compact this thread");
  faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("ok")));
  const models = createModels();
  models.setProvider(withPrimeWindows(faux.provider, at));
  const settings = withPrimeCompaction({ compaction: { backgroundTokens: 0 } } as never, at);
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "run.sqlite")), { models, registry: createRegistry(), settings }, context);
  try {
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    const kinds = async () => (await root.entries({ order: "ascending" }, 1000, undefined, context)).items.map(entry => entry.kind);
    const page = "word ".repeat(1_000);
    await (await root.submit({ type: "input", content: `first ${page}` }, context)).wait(context);
    assert.ok(!(await kinds()).includes("pi.compaction"), "about 1,250 tokens stay under 2,000");
    await (await root.submit({ type: "input", content: `second ${page}` }, context)).wait(context);
    await harness.waitForIdle(context);
    assert.ok((await kinds()).includes("pi.compaction"), `about 2,500 tokens pass 3,000 - 1,000: ${(await kinds()).join(", ")}`);
  } finally {
    await harness.close(context);
  }
});
