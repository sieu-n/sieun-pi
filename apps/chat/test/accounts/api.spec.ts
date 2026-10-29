import { expect, test } from "@playwright/test";
import { AGENT, DM, readView } from "./helpers.ts";

// A box with 80 busy cores slows a cold dev-server page, so each walk gets 60 s.
test.describe.configure({ timeout: 60_000 });

/** The server half (FEATURES.md 40, 41, 43 and 44) through the same HTTP calls the tab makes. Line 42, the service log, has no browser view. */
test("40 GET accounts answers the pool for a thread, read as its root tree, and with no thread", async ({ request }) => {
  const forDm = await readView(request, DM);
  const forAgent = await readView(request, AGENT);
  expect(forDm.sessionId).toMatch(/^pi-durable:[^:]+$/);
  expect(forAgent.sessionId).toBe(forDm.sessionId);
  expect(forDm.providers.map(entry => entry.provider).sort()).toEqual(["anthropic", "openai-codex"]);
  const none = await readView(request);
  expect(none.sessionId).toBeNull();
  const pool = await (await request.get("/api/pool")).json();
  expect(pool.sessionId).toBeNull();
  const started = Date.now();
  await readView(request, DM);
  expect(Date.now() - started, "a GET answers from the shared reading at once").toBeLessThan(2_000);
});

test("41 a bad action answers 400 with the pool's own message", async ({ request }) => {
  const response = await request.post("/api/accounts", { data: { action: "pin", provider: "anthropic", account: "no-such-account" } });
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { error?: string }).error).toBeTruthy();
});

test("43 44 login and refresh have their live state reads", async ({ request }) => {
  const login = await request.get("/api/accounts/login");
  expect(login.ok()).toBe(true);
  const refresh = await request.get("/api/accounts/refresh");
  expect(refresh.ok()).toBe(true);
  expect(Array.isArray(await refresh.json())).toBe(true);
});
