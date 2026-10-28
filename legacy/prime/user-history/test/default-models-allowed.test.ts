// Owner rule c185 (2026-10-27): defaults never pick an older model. Until 10-28 the chat's model menu offered openai-codex/gpt-6-astra
// first among its default favorites. Every default, fallback and fixed model pick below must name a model from config/allowed-models.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_MODELS, isAllowedModel } from "../../../../config/allowed-models.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const CLEAN_ROOM = "legacy/prime/user-history/scripts/clean-room";

/** The files that hold a default, fallback or fixed model pick. Each one must name at least one model, so a move or rename fails here. */
const NAMED_FILES = [
  "legacy/prime/user-history/src/client/ModelMenu.svelte",
  "legacy/prime/user-history/scripts/latency-probe.mjs",
  "legacy/prime/user-history/scripts/duties/chat-page-mac.ts",
  `${CLEAN_ROOM}/clean-room.ts`,
  `${CLEAN_ROOM}/resume-model.ts`,
  `${CLEAN_ROOM}/waiting-session.ts`,
  "legacy/prime/scripts/prove_runtime.mjs",
  "apps/chat/server/app.ts",
  "apps/chat/server/host/fixture.ts",
  "packages/pi-host/src/main.ts",
];
/** Every clean-room scenario script, since a scenario fixes the model its chat and job run on. */
const CODE_FILES = [...new Set([...NAMED_FILES,
  ...readdirSync(join(ROOT, CLEAN_ROOM)).filter(name => name.endsWith(".ts")).map(name => `${CLEAN_ROOM}/${name}`)])];

/** Every model a source names outside its comments, as provider/id. */
export function namedModels(source: string): string[] {
  const code = source.split("\n").filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");
  const found = new Set<string>();
  for (const match of code.matchAll(/\b(anthropic|openai-codex|openai)\/((?:claude|gpt)-[A-Za-z0-9._-]+)/g)) found.add(`${match[1]}/${match[2]!.replace(/[.-]+$/, "")}`);
  for (const match of code.matchAll(/provider: "([^"]+)", (?:modelId|id): "([^"]+)"/g)) found.add(`${match[1]}/${match[2]}`);
  for (const match of code.matchAll(/getModel\("([^"]+)", "([^"]+)"\)/g)) found.add(`${match[1]}/${match[2]}`);
  return [...found];
}

function pstackModels(): string[] {
  const config = JSON.parse(readFileSync(join(ROOT, "config/pstack-models.json"), "utf8")) as { roles: Record<string, { model: string }[]>; policy: { allowed: string[]; default: string } };
  return [...new Set([
    ...Object.values(config.roles).flat().map(entry => entry.model),
    ...config.policy.allowed.filter(model => model !== "inherit-parent"),
    config.policy.default.split(" ")[0]!,
  ])];
}

test("the allowed set is the newest model of each c185 tier", () => {
  assert.deepEqual([...ALLOWED_MODELS].sort(), ["anthropic/claude-fable-5-1", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5",
    "openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-terra"]);
});

test("the check finds a retired model in a default list and skips comments", () => {
  const source = '// run1 used openai-codex/gpt-6-astra\nconst DEFAULTS = ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"];\nconst M = { provider: "anthropic", modelId: "claude-opus-5" };\n';
  assert.deepEqual(namedModels(source).filter(model => !isAllowedModel(model)), ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5"]);
});

test("every default, fallback and fixed model pick names an allowed model", () => {
  const outside: string[] = [];
  for (const file of CODE_FILES) {
    const models = namedModels(readFileSync(join(ROOT, file), "utf8"));
    if (NAMED_FILES.includes(file)) assert.ok(models.length > 0, `${file} names no model any more; drop it from CODE_FILES or fix the parser`);
    outside.push(...models.filter(model => !isAllowedModel(model)).map(model => `${file}: ${model}`));
  }
  outside.push(...pstackModels().filter(model => !isAllowedModel(model)).map(model => `${relative(ROOT, join(ROOT, "config/pstack-models.json"))}: ${model}`));
  assert.deepEqual(outside, [], "models outside config/allowed-models.ts (owner rule c185)");
});

test("the model menu's default favorites are allowed and lead with Opus 5.5", () => {
  const source = readFileSync(join(ROOT, "legacy/prime/user-history/src/client/ModelMenu.svelte"), "utf8");
  const list = /const DEFAULT_FAVORITES[^=]*= (\[[^\]]*\])/.exec(source);
  assert.ok(list, "ModelMenu.svelte has a DEFAULT_FAVORITES list");
  const favorites = JSON.parse(list[1]!) as string[];
  assert.equal(favorites[0], "anthropic/claude-opus-5-5");
  assert.deepEqual(favorites.filter(model => !isAllowedModel(model)), []);
});
