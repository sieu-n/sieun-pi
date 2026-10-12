import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALL_RULES, CHECK_IN_MS, JOB_CLEANUP_IDLE_MS, MOVES_PER_DAY, NO_REPORT_GRACE_MS, STEP_STALE_MS, TIER_UNITS, formatQuantity, howTopics, settingText, type Rule } from "../src/client/how-it-works.ts";
import { POOL_DEFAULTS } from "../src/client/pool-config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VEND = readFileSync(join(ROOT, "components/pi-pool/vend.py"), "utf8");

/** A number literal or a product of them (`24 * 3600`), the only shapes vend.py's DEFAULTS use for numbers. */
function pythonNumber(expression: string): number {
  const factors = expression.split("*").map(part => Number(part.trim()));
  assert.ok(factors.every(Number.isFinite), `not a number expression: ${expression}`);
  return factors.reduce((product, factor) => product * factor, 1);
}

/** A key of vend.py's DEFAULTS dict, or a top-level `NAME = <number>`. */
function vendValue(symbol: string): number {
  const key = symbol.startsWith("DEFAULTS.") ? symbol.slice("DEFAULTS.".length) : null;
  const body = key ? VEND.slice(VEND.indexOf("DEFAULTS = {"), VEND.indexOf("\n}\n", VEND.indexOf("DEFAULTS = {"))) : VEND;
  const match = key ? new RegExp(`^\\s+"${key}":\\s*([^,\\n]+),`, "m").exec(body) : new RegExp(`^${symbol} = ([^\\n#]+)`, "m").exec(body);
  assert.ok(match, `${symbol} not found in vend.py`);
  return pythonNumber(match[1]!);
}

/** A key of vend.py's DEFAULTS dict whose value is a one-line JSON object, such as `max_moves_per_day`. */
function vendObject(key: string): unknown {
  const match = new RegExp(`^\\s+"${key}":\\s*(\\{[^\\n]*\\}),`, "m").exec(VEND);
  assert.ok(match, `DEFAULTS.${key} not found in vend.py`);
  return JSON.parse(match[1]!);
}

async function tsValue(file: string, symbol: string): Promise<number> {
  const module = await import(pathToFileURL(join(ROOT, file)).href) as Record<string, unknown>;
  const value = symbol.split(".").reduce<unknown>((object, key) => (object as Record<string, unknown> | undefined)?.[key], module);
  assert.equal(typeof value, "number", `${file} ${symbol} is not a number`);
  return value as number;
}

const sourceValue = (rule: Rule): Promise<number> => rule.source.file.endsWith(".py") ? Promise.resolve(vendValue(rule.source.symbol)) : tsValue(rule.source.file, rule.source.symbol);

test("every How it works value matches the code it names", async () => {
  assert.ok(ALL_RULES.length > 0);
  for (const rule of ALL_RULES) assert.equal(rule.value.amount, await sourceValue(rule), `${rule.id}: ${rule.source.file} ${rule.source.symbol}`);
});

test("the literals that mirror server code and vend.py match their source", async () => {
  assert.equal(CHECK_IN_MS, await tsValue("components/user-history/src/chat-checkin.ts", "CHECK_IN_MS"));
  assert.equal(STEP_STALE_MS, await tsValue("components/user-history/src/chat-checkin.ts", "STEP_STALE_MS"));
  assert.equal(JOB_CLEANUP_IDLE_MS, await tsValue("components/user-history/src/chat-checkin.ts", "JOB_CLEANUP_IDLE_MS"));
  assert.equal(NO_REPORT_GRACE_MS, await tsValue("components/user-history/src/chats.ts", "NO_REPORT_GRACE_MS"));
  for (const [key, value] of Object.entries(POOL_DEFAULTS)) assert.equal(value, vendValue("DEFAULTS." + key), key);
  assert.deepEqual(MOVES_PER_DAY, vendObject("max_moves_per_day"));
  assert.deepEqual(TIER_UNITS, vendObject("tier_units"));
});

test("a pool rule that names a config key names a key of vend.py's DEFAULTS", () => {
  for (const rule of ALL_RULES) {
    if (rule.setting.kind !== "pool-config") continue;
    assert.equal(rule.source.symbol, "DEFAULTS." + rule.setting.key, rule.id);
  }
});

test("rule ids are unique and every topic has a diagram", () => {
  assert.equal(new Set(ALL_RULES.map(rule => rule.id)).size, ALL_RULES.length);
  for (const topic of howTopics(null)) assert.match(topic.diagram, /^flowchart /);
});

test("values read in plain units", () => {
  assert.equal(formatQuantity({ amount: 15 * 60_000, unit: "ms" }), "15 min");
  assert.equal(formatQuantity({ amount: 2 * 60 * 60_000, unit: "ms" }), "2 h");
  assert.equal(formatQuantity({ amount: 90_000, unit: "ms" }), "90 s");
  assert.equal(formatQuantity({ amount: 3600, unit: "s" }), "1 h");
  assert.equal(formatQuantity({ amount: 24 * 3600, unit: "s" }), "24 h");
  assert.equal(formatQuantity({ amount: 95, unit: "percent" }), "95%");
  assert.equal(formatQuantity({ amount: 120, unit: "s" }), "2 min");
});

test("a pool value this Mac overrides shows the override, names the default, and reaches the step text", () => {
  const topics = howTopics({ admit_5h_max_pct: 60 });
  const rules = topics.flatMap(topic => topic.rules);
  const cap = rules.find(rule => rule.id === "admit-5h")!;
  assert.equal(formatQuantity(cap.value), "60%");
  assert.equal(settingText(cap), "Set on this Mac (default 70%): pi-pool set admit_5h_max_pct");
  const low = rules.find(rule => rule.id === "low-admit-5h")!;
  assert.equal(low.default, undefined);
  assert.equal(settingText(low), "Default. Override: pi-pool set low_admit_5h_max_pct");
  const pool = topics.find(topic => topic.id === "pool")!;
  assert.match(pool.steps.find(step => step.title === "Admit cap")!.text, /only under 60% of its 5-hour window and 98% of its week/);
  assert.match(pool.steps.find(step => step.title === "Priority")!.text, /only under 50% of the 5-hour window/);
  assert.match(pool.steps.find(step => step.title === "Slots")!.text, /4 threads every 2 min on a Max 20x plan and 1 on the others/);
  assert.match(pool.diagram, /under 60% 5h/);
});
