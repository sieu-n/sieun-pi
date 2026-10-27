import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measureNumbers, numbersMetrics, type NumbersDeps, type Sources } from "../scripts/duties/slack-green-numbers.ts";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const CHAT = "chat-1";
const env = { SUPABASE_SERVICE_KEY: "s", POSTHOG_PERSONAL_API_KEY: "p", POSTHOG_PROJECT_ID: "1", POSTHOG_DASHBOARD_API_KEY: "d" };
const funnel = (word: string) => ({ command: ["node", "--import", "tsx", `scripts/duties/${word}.ts`], cwd: "/x", timeoutMs: 1 });

/** A chat data dir with d1 (last run clean), d2 (last run had a source error, a later skip) and this duty itself. */
async function dataDir(d2Error: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sg-numbers-test-"));
  await mkdir(join(dir, "duties"));
  const detail = join(dir, "d2.json");
  await writeFile(detail, JSON.stringify({ metrics: { source_errors: d2Error ? 1 : 0 },
    flagged: d2Error ? [{ kind: "source_error", excerpt: "prod Supabase threads read failed: HTTP 401" }] : [] }));
  await writeFile(join(dir, "duties", `${CHAT}.json`), JSON.stringify({ version: 1, duties: [
    { id: "d1", name: "Visitors become paying users", status: "active", precheck: funnel("slack-green-funnel") },
    { id: "d2", name: "Reviewers get trials", status: "active", precheck: funnel("slack-green-review-trials") },
    { id: "d5", name: "Slack green numbers", status: "active", precheck: funnel("slack-green-numbers") },
  ] }));
  const run = (duty: string, verdict: string, extra = {}) => JSON.stringify({ duty, at: NOW - 3_600_000, trigger: "schedule", ms: 1, verdict, metrics: {}, summary: "", ...extra });
  await writeFile(join(dir, "duties", `${CHAT}.runs.jsonl`), [run("d1", "missed"), run("d2", "met", { detail }), run("d2", "skipped"), ""].join("\n"));
  return dir;
}

const account = (id: string, email: string, days = 1) => ({ id, email, created_at: new Date(NOW - days * 86_400_000).toISOString() });

function fakeFetch(options: { supabaseDown?: boolean; tileError?: boolean; throttled?: number; busyStatus?: number }): typeof fetch {
  let throttled = options.throttled ?? 0;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.includes("posthog") && throttled > 0) { throttled--; return reply(options.busyStatus ?? 429, { detail: "Too many queries are running right now" }); }
    if (url.includes("/auth/v1/admin/users")) return options.supabaseDown ? reply(503, { msg: "down" })
      : reply(200, { users: [account("a", "a@x.com"), account("b", "b@x.com"), account("q", "sg-qa-1@slack.green"), account("old", "o@x.com", 30)] });
    if (url.includes("/dashboards/")) return reply(200, { tiles: [{ insight: { id: 7, name: "Funnel", query: { kind: "InsightVizNode" } } }, { insight: null }] });
    if (url.endsWith("/query/") && url.includes("projects/1/query")) {
      return reply(200, { results: [["a", "a@x.com"], ["b", "b@x.com"], ["q", "sg-qa-1@slack.green"], ["sg-qa-x", null]],
        ...options.tileError ? { error: "Query timed out" } : {} });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

const deps = (dir: string, options: { supabaseDown?: boolean; tileError?: boolean; throttled?: number; busyStatus?: number } = {}): NumbersDeps =>
  ({ fetch: fakeFetch(options), now: () => NOW, dataDir: dir, env, sleep: async () => {} });

test("a clean day reads 0 numbers wrong, with QA accounts and QA signups left out of both sides", async () => {
  const dir = await dataDir(false);
  try {
    const output = await measureNumbers(deps(dir), CHAT);
    assert.equal(output.metrics.numbers_wrong, 0);
    assert.equal(output.metrics.duty_source_errors, 0);
    assert.equal(output.metrics.signup_count_gap, 0);
    assert.equal(output.metrics.posthog_signups_7d, 2);
    assert.equal(output.metrics.dashboard_tiles_failing, 0);
    assert.equal(output.metrics.checks, 2 + 1 + 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a sibling duty whose last run had a source error makes the numbers wrong (10-18: funnel, review and email checks could not read prod)", async () => {
  const dir = await dataDir(true);
  try {
    const output = await measureNumbers(deps(dir), CHAT);
    assert.equal(output.metrics.duty_source_errors, 1);
    assert.equal(output.metrics.numbers_wrong, 1);
    assert.match(output.flagged!.find(slice => slice.kind === "duty_source_error")!.excerpt, /^d2 Reviewers get trials.*HTTP 401/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unread Supabase leaves signup_count_gap unmeasured and still counts as a wrong number", async () => {
  const dir = await dataDir(false);
  try {
    const output = await measureNumbers(deps(dir, { supabaseDown: true }), CHAT);
    assert.equal(output.metrics.signup_count_gap, undefined);
    assert.equal(output.metrics.numbers_wrong, 1);
    assert.match(output.flagged!.find(slice => slice.kind === "source_error")!.excerpt, /prod Supabase accounts: .*HTTP 503/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a tile that errors counts once per dashboard in the headline and once per tile in dashboard_tiles_failing", async () => {
  const dir = await dataDir(false);
  try {
    const output = await measureNumbers(deps(dir, { tileError: true }), CHAT);
    assert.equal(output.metrics.dashboard_tiles_failing, 2);
    assert.equal(output.metrics.numbers_wrong, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a signup gap over the margin of 2 is a wrong number and names the accounts with no PostHog signup", () => {
  const sources: Sources = { duties: [], dashboards: [], errors: [],
    accounts: ["a", "b", "c", "d"].map(id => account(id, `${id}@x.com`)), signups: [{ id: "a", email: "a@x.com" }] };
  const output = numbersMetrics(sources, NOW);
  assert.equal(output.metrics.signup_count_gap, 3);
  assert.equal(output.metrics.numbers_wrong, 1);
  assert.match(output.flagged!.find(slice => slice.kind === "signup_gap")!.excerpt, /no PostHog signup: b, c, d/);
});

test("a PostHog 429 waits and tries again instead of leaving the signup gap unmeasured (first live run, 10-19)", async () => {
  const dir = await dataDir(false);
  try {
    const output = await measureNumbers(deps(dir, { throttled: 2 }), CHAT);
    assert.equal(output.metrics.signup_count_gap, 0);
    assert.equal(output.metrics.numbers_wrong, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a PostHog 503 at capacity waits and tries again like a 429 (Search traffic duty, 10-19 14:40Z)", async () => {
  const dir = await dataDir(false);
  try {
    const output = await measureNumbers(deps(dir, { throttled: 2, busyStatus: 503 }), CHAT);
    assert.equal(output.metrics.signup_count_gap, 0);
    assert.equal(output.metrics.numbers_wrong, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
