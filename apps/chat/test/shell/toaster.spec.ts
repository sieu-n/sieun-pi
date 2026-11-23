import { expect, test } from "@playwright/test";

test("in a narrow pane a toast spans the pane on one or two lines, centered", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  // The server names its web build in the live socket's hello (stores.svelte.ts); another name than this page's reads as a new release.
  await page.routeWebSocket(/\/api\/live/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => server.send(message));
    server.onMessage(message => {
      const event = typeof message === "string" ? (JSON.parse(message) as { type?: string; me?: { web?: string } }) : null;
      if (event?.type === "hello" && event.me) ws.send(JSON.stringify({ ...event, me: { ...event.me, web: "/assets/index-next.js" } }));
      else ws.send(message);
    });
  });
  await page.goto("/#/settings/usage");
  const toast = page.getByRole("region", { name: "Notifications" }).locator(".toast").filter({ hasText: "A new version of the chat is out" });
  await expect(toast).toBeVisible();
  const box = (await toast.boundingBox())!;
  expect(box.width).toBeGreaterThan(420 - 32 - 2);
  expect(box.height).toBeLessThan(80);
  expect(Math.abs(box.x + box.width / 2 - 210)).toBeLessThan(2);
});
