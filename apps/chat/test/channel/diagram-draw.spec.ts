import { expect, test } from "@playwright/test";
import { open, row, tag } from "./helpers.ts";

/**
 * Mermaid measures a diagram's labels in a box it adds to the page (lib/ui/mermaid.ts). Under the app that box made the page taller than the
 * window while the diagram drew, so a scrollIntoView then, such as a jump to a linked post, scrolled the whole app up by the diagram's height.
 */
test("a diagram that draws never makes the page taller than the window", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { tallest: number };
    w.tallest = 0;
    new MutationObserver(() => {
      w.tallest = Math.max(w.tallest, document.scrollingElement!.scrollHeight - innerHeight);
    }).observe(document, { childList: true, subtree: true });
  });
  const name = `diagram-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [] } })).json()) as { id: string }).id;
  const text = `The flow of ${name}:\n\n\`\`\`mermaid\nflowchart TD\n  push --> ci{CI}\n  ci -- pass --> staging\n  ci -- fail --> fix --> push\n\`\`\``;
  const sent = await page.request.post(`/api/c/${room}/send`, { data: { text, requestId: crypto.randomUUID() } });
  const id = ((await sent.json()) as { item: { id: string } }).item.id;
  await open(page, `#/c/${room}`);
  await expect(row(page, id).locator(".diagram-slot svg").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { tallest: number }).tallest)).toBe(0);
});
