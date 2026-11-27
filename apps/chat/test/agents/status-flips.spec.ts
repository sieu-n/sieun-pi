import { expect, test } from "@playwright/test";

// A box with 80 busy cores slows a cold page, so each walk gets 60 s.
test.describe.configure({ timeout: 60_000 });

/**
 * A busy agent flips between working and sleeping at every model call (pi-host says sleeping while a run waits for a slot or an account),
 * and each flip brings the page a new live card. On 11-27 a walk of the live page saw the open agent's account chip read the pool again at
 * each new card, ag_devops-guy's 25 times in 3 min, and its config read again at each flip (~/work/p354-reread-walk). The spec sends the
 * flips over the live socket and counts the reads the open agent page sends after it settled.
 */
test("an open agent whose run flips between working and sleeping reads its accounts and config no more", async ({ page }) => {
  let socket: { send: (message: string) => void } | undefined;
  // Once the spec drives the run's status, the fixture's own status and card events for its agents are held back, so only the flips count.
  let driving = false;
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const type = (JSON.parse(String(message)) as { type?: string }).type;
      if (!driving || (type !== "status" && type !== "agent")) ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && (url.pathname === "/api/accounts" || url.pathname === "/api/agents/ag_vent/config")) reads.push(url.pathname);
  });
  await page.goto("/#/agents/ag_vent");
  const panel = page.getByTestId("agent-config");
  await expect(panel.getByTestId("account-chip")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => socket !== undefined).toBe(true);
  const status = (next: string) => socket!.send(JSON.stringify({ type: "status", conversation: "ag_vent", status: next }));
  // The run starts: a real change, which reads the config once.
  driving = true;
  status("working");
  await expect(panel.locator(".line")).toHaveAttribute("data-status", "working");
  await page.waitForTimeout(1_500);
  const before = reads.length;
  for (let flip = 1; flip <= 10; flip += 1) {
    status(flip % 2 ? "sleeping" : "working");
    await page.waitForTimeout(200);
  }
  await expect(panel.locator(".line")).toHaveAttribute("data-status", /working|sleeping/);
  await page.waitForTimeout(1_000);
  expect(reads.slice(before)).toEqual([]);
});
