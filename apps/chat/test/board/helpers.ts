import type { APIRequestContext } from "@playwright/test";

export const HARNESS = "0f1e0000-0000-4000-8000-000000000002";
export const VENT = "0f1e0000-0000-4000-8000-000000000001";
export const CRAWLER = "0f1e0000-0000-4000-8000-000000000003";
/** The agents that hold those work threads (server/fixture/seed.ts FIXTURE_AGENTS); For you and board links name a board by its agent. */
export const HARNESS_AGENT = "ag_ai-harness-developer-environment-vp";
export const CRAWLER_AGENT = "ag_crawler-vp";

const server = process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186";

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(server + path, { data });
  if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

/** Put the asks, duties and check-ins the specs change back to the fixture's seed, so a spec passes on a server earlier runs changed. */
export async function resetFixture(request: APIRequestContext): Promise<void> {
  const open = (id: string) => ({ op: "todo_update", id, done: false, reply: null });
  await post(request, `/api/threads/${HARNESS}/board`, { ops: [open("t1"), open("t2"), { op: "todo_update", id: "t3", done: true, reply: "yes" }] });
  await post(request, `/api/threads/${CRAWLER}/board`, { ops: [open("t1")] });
  await post(request, `/api/threads/${VENT}/board`, { ops: [open("t1")] });
  await post(request, `/api/threads/${HARNESS}/duties`, { duty: "d1", action: "resume" });
  await post(request, `/api/threads/${HARNESS}/duties`, { duty: "d2", action: "pause" });
  for (const chat of [HARNESS, VENT, CRAWLER]) await post(request, `/api/threads/${chat}/check-in`, { pause: null, everyMs: 120 * 60_000 });
}
