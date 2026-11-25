import { expect, test } from "@playwright/test";
import { card, grid, listAgents, listJobs, openAgents } from "./helpers.ts";

/**
 * A big hello goes over the socket as the hello and `list_part` messages (server/app.ts `helloMessages`), because a browser builds each
 * message's string in one task: on 11-25 the 2.5 MB cold hello of live :5184 held the page 528 to 697 ms at CPU rate 1. This proxy splits
 * the fixture's hello into one part per item and holds the last part back. Until it comes no card shows a job count that is short.
 */
type Json = Record<string, unknown> & { type: string; jobs?: Json[]; conversations?: Json[]; parts?: number };

test("a hello sent in parts shows each card's whole job count, and no short count before its last part", async ({ page, request }) => {
  const [agents, jobs] = await Promise.all([listAgents(request), listJobs(request)]);
  const total = (id: string) => jobs.filter((job) => job.agent?.id === id).length;
  /** A card's count line, such as "3 jobs, 1 working". */
  const whole = (id: string) => new RegExp(`^${total(id)} ${total(id) === 1 ? "job" : "jobs"}(,|$)`);
  test.skip(!agents.some((agent) => total(agent.id) > 1), "needs an agent with two jobs");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let split = 0;
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as Json;
      if (event.type !== "hello" || event.parts) return ws.send(message);
      const parts = [...event.jobs!.map((job) => ({ jobs: [job], conversations: [] })), ...event.conversations!.map((c) => ({ jobs: [], conversations: [c] }))];
      const [first, ...rest] = parts;
      split += 1;
      ws.send(JSON.stringify({ ...event, ...first, parts: rest.length }));
      for (const part of rest.slice(0, -1)) ws.send(JSON.stringify({ type: "list_part", ...part }));
      void held.then(() => ws.send(JSON.stringify({ type: "list_part", ...rest.at(-1) })));
    });
  });
  await openAgents(page);
  await expect(grid(page).getByRole("gridcell")).toHaveCount(agents.length);
  await expect.poll(() => split).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  for (const agent of agents) {
    const shown = await card(page, agent).locator("[data-jobs]").allTextContents();
    expect(shown.filter((text) => !whole(agent.id).test(text)), agent.name).toEqual([]);
  }
  release();
  for (const agent of agents) if (total(agent.id)) await expect(card(page, agent).locator("[data-jobs]")).toHaveText(whole(agent.id));
});
