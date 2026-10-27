import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { grafanaPrometheus, Usage } from "../src/usage/lgtm.ts";
import type { UsageModelRow, UsageWindow } from "../src/shared/usage.ts";

/**
 * Settings > Usage and virev.ai's /sieun/tokens must show the same numbers for the same window. The fixture holds LGTM's
 * answers to the four PromQL reads this table made for 30d on 2026-10-27 and the rows it built. auto-sns-agent keeps the
 * same file at apps/search/tests/unit/fixtures/sieun-usage-contract.json, and its sieun-usage-contract.test.ts holds the
 * tokens page to it, so a change to these reads or this fold fails here until both pages and both copies move together.
 */
const contract = JSON.parse(readFileSync(new URL("fixtures/usage-contract.json", import.meta.url), "utf8")) as {
  now: number; window: UsageWindow; answers: Record<string, unknown[]>; models: UsageModelRow[];
};

test("the Settings > Usage table reads the fixture's PromQL and builds the rows the tokens page is held to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-contract-"));
  const config = join(dir, "grafana.json");
  writeFileSync(config, JSON.stringify({ url: "https://obs.example", token: "t" }));
  const unknown: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const query = new URL(String(input)).searchParams.get("query") ?? "";
    const result = contract.answers[query];
    if (!result) unknown.push(query);
    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: result ?? [] } }));
  }) as typeof fetch;
  const { models } = await new Usage(grafanaPrometheus(config, fetcher), () => contract.now).models(contract.window);
  assert.deepEqual(unknown, []);
  const key = (row: UsageModelRow) => `${row.box} ${row.model}`;
  const sorted = (rows: UsageModelRow[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  assert.deepEqual(sorted(models), sorted(contract.models));
});
