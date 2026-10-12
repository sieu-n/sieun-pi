import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";
import { judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { measureReviews, type ReviewDeps, type ReviewThread, slice, waiting } from "../scripts/duties/slack-green-review-trials.ts";

const NOW = Date.parse("2026-10-13T14:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const thread = (id: string, hours: number, days: number | null, user: string | null = "u-" + id): ReviewThread =>
  ({ id, created_at: hoursAgo(hours), user_id: user, trial_extension_days: days, rating: null, content: "Works great!\n keeps me green", image_url: `https://img/${id}.png` });
const THREADS = [thread("aaaa1111-new", 2, null), thread("bbbb2222-old", 30, null), thread("cccc3333-done", 400, 14),
  thread("684a952b-test", 5000, null, null), thread("601e7118-test", 7000, null, "owner")];

function deps(options: { threads?: unknown; threadsStatus?: number; subsStatus?: number; key?: string }): ReviewDeps & { requests: { url: string; method: string }[] } {
  const requests: { url: string; method: string }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/rest/v1/threads?")) return new Response(JSON.stringify(options.threads ?? THREADS), { status: options.threadsStatus ?? 200 });
    if (url.includes("/rest/v1/subscriptions?")) return new Response(JSON.stringify([{ user_id: "u-bbbb2222-old", plan_type: "free", status: "active", trial_ends_at: null }]), { status: options.subsStatus ?? 200 });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, now: () => NOW, url: "https://x.supabase.co", key: options.key ?? "service", requests };
}

test("reviews: counts posts over 24 h with no trial decision, skips the owner's test posts, and flags new ones for the job", async () => {
  const run = deps({});
  const { output } = await measureReviews(run);
  assert.deepEqual(output.metrics, { reviews_waiting_24h: 1, source_errors: 0 });
  assert.deepEqual(output.flagged?.map(item => item.kind), ["new", "waiting", "summary"]);
  assert.match(output.flagged![1]!.excerpt, /review bbbb2222-old .*30 h ago.*plan free \(active\), trial ends never set; text "Works great! keeps me green"; screenshot https:\/\/img\/bbbb2222-old.png/);
  assert.ok(run.requests.every(request => request.method === "GET"), "the precheck only reads");
  assert.equal(new URL(run.requests.find(request => request.url.includes("subscriptions"))!.url).searchParams.get("user_id"), "in.(u-aaaa1111-new,u-bbbb2222-old)");
});

test("reviews: a read that fails or no key is a source error, never a 0-waiting pass on its own", async () => {
  const down = await measureReviews(deps({ threadsStatus: 503 }));
  assert.deepEqual(down.output.metrics, { reviews_waiting_24h: 0, source_errors: 1 });
  assert.match(down.output.flagged![0]!.excerpt, /HTTP 503/);
  const noKey = await measureReviews(deps({ key: "" }));
  assert.equal(noKey.output.metrics.source_errors, 1);
  const noSubs = await measureReviews(deps({ subsStatus: 500 }));
  assert.deepEqual(noSubs.output.metrics, { reviews_waiting_24h: 1, source_errors: 1 });
});

test("reviews: waiting and slice", () => {
  const { open, late } = waiting(THREADS, NOW);
  assert.deepEqual(open.map(item => item.id), ["aaaa1111-new", "bbbb2222-old"]);
  assert.deepEqual(late.map(item => item.id), ["bbbb2222-old"]);
  assert.equal(slice(thread("x", 1, null), undefined, NOW).kind, "new");
  assert.match(slice(thread("x", 25, null), undefined, NOW).excerpt, /no subscription row/);
});

test("review duty file parses, every metric is a key the precheck writes, and add.ts resolves its cwd", async () => {
  const component = join(import.meta.dirname, "..");
  const file = join(component, "scripts", "duties", "slack-green-review-trials.duty.json");
  const duty = parseDutyInput(JSON.parse(await readFile(file, "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "23:00" });
  const { output } = await measureReviews(deps({}));
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
  assert.equal(judge(duty.metrics, output).verdict, "missed");
  const dataDir = await mkdtemp(join(tmpdir(), "duty-add-"));
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/add.ts", "chat1", file, "--data-dir", dataDir], { cwd: component });
    const [stored] = await new DutyStore(dataDir).list("chat1");
    assert.equal(stored?.name, "Reviewers get trials");
    assert.equal(stored?.precheck.cwd, component);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
