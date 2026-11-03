import { expect, test, type Locator, type Page } from "@playwright/test";
import { composerInput, conversation, open, tag } from "../channel/helpers.ts";

/**
 * Room posts draw mermaid through the one renderer thread turns use (lib/ui/Markdown.svelte): a DM post, a channel post and a channel thread
 * reply each draw the diagram lazily in the current theme, Expand opens it large in the lightbox, and source that does not parse shows as source.
 * The fixture's agents answer "mermaid" with a flow and "broken diagram" with a block that does not parse (server/host/fixture.ts replyFor).
 */
test.use({ viewport: { width: 1512, height: 945 } });
// The first mermaid load on a cold dev server takes up to 20 s while four workers start at once.
test.describe.configure({ timeout: 90_000 });

const FLOW = "```mermaid\nflowchart TD\n  owner[Owner] --> comm[Comm thread]\n  comm --> work[Work thread]\n  work --> jobs[Jobs]\n```";

async function testAgent(page: Page, name: string): Promise<{ id: string; room: string; name: string }> {
  const res = await page.request.post("/api/agents", { data: { kind: "chat", name: `${name} ${tag()}`, test: true } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; room: string; name: string };
}

async function send(scope: Locator, page: Page, text: string): Promise<void> {
  await composerInput(scope).click();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

/** Checks a drawn diagram in `block`: an SVG with the given label, and Expand draws it inline in the lightbox, larger than in the post with no label clipped. */
async function expectDrawn(page: Page, block: Locator, label: string): Promise<void> {
  await block.scrollIntoViewIfNeeded();
  const svg = block.locator(".diagram-slot svg");
  await expect(svg).toBeVisible({ timeout: 20_000 });
  await expect(svg.getByText(label).first()).toBeVisible();
  await expect(block.locator("pre")).toBeHidden();
  const area = (box: { width: number; height: number } | null) => box!.width * box!.height;
  const inline = area(await svg.boundingBox());
  await block.getByRole("button", { name: "Expand" }).click();
  const lightbox = page.getByRole("dialog", { name: "Diagram" });
  const big = lightbox.locator(".svg-frame svg");
  await expect(big).toBeVisible();
  expect(area(await big.boundingBox())).toBeGreaterThan(inline);
  const clipped = await big.evaluate((svg) => [...svg.querySelectorAll("foreignObject")].filter((fo) => {
    const label = fo.firstElementChild as HTMLElement | null;
    return !!label && label.scrollWidth > (fo as SVGForeignObjectElement).width.baseVal.value + 1;
  }).length);
  expect(clipped).toBe(0);
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
}

test("an agent's DM post draws its mermaid flow, redraws it in dark mode, and a broken one falls back to its source", async ({ page }) => {
  const agent = await testAgent(page, "diagram dm");
  await open(page, `#/c/${agent.room}`);
  await send(conversation(page), page, `show it as a mermaid flow ${tag()}`);
  const post = conversation(page).locator(".row:not(.own)").filter({ has: page.locator(".diagram-block") }).first();
  const block = post.locator(".diagram-block");
  await expectDrawn(page, block, "pi-host");
  expect(await block.locator(".diagram-slot svg style").first().textContent()).toContain("#f3f3f4");
  await page.evaluate(() => (document.documentElement.dataset.colorMode = "dark"));
  await expect.poll(async () => block.locator(".diagram-slot svg style").first().textContent(), { timeout: 15_000 }).toContain("#292929");
  await page.evaluate(() => (document.documentElement.dataset.colorMode = "light"));

  await send(conversation(page), page, `broken diagram ${tag()}`);
  const failed = conversation(page).locator(".row:not(.own) .diagram-block.diagram-failed");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed.locator(".diagram-error")).toHaveText("This diagram did not parse, so here is its source. Parse error on line 2.");
  await expect(failed.locator("pre")).toContainText("a --> [unclosed");
  await expect(failed.getByRole("button", { name: "Expand" })).toHaveCount(0);
});

test("the owner's own DM post with a mermaid block draws it too", async ({ page }) => {
  const agent = await testAgent(page, "diagram own");
  await open(page, `#/c/${agent.room}`);
  await send(conversation(page), page, `${tag()} here is my plan\n\n${FLOW}`);
  const mine = conversation(page).locator(".row.own").filter({ has: page.locator(".diagram-block") });
  await expectDrawn(page, mine.locator(".diagram-block"), "Comm thread");
});

test("a channel post draws its diagram in the Slack row, and an agent's thread reply draws one in the thread pane", async ({ page }) => {
  const agent = await testAgent(page, "diagram ch");
  const word = tag();
  const created = await page.request.post("/api/rooms", { data: { kind: "channel", name: `diagrams-${word}`, members: [agent.id], test: true } });
  expect(created.ok()).toBe(true);
  const room = (await created.json()) as { id: string };
  await open(page, `#/c/${room.id}`);

  await send(conversation(page), page, `the flow ${word}\n\n${FLOW}`);
  const root = conversation(page).locator(".row.slack").filter({ hasText: `the flow ${word}` });
  await expectDrawn(page, root.locator(".diagram-block"), "Work thread");

  // The member wakes on every post and answers in the post's thread; the fixture answers a post that says mermaid with a flow.
  const pill = root.locator("[data-thread-pill]");
  await expect(pill).toBeVisible({ timeout: 20_000 });
  await pill.click();
  const pane = page.getByTestId("thread-pane");
  const reply = pane.locator(".row").filter({ has: page.locator(".diagram-block") }).filter({ hasNot: page.locator(".row.own") }).last();
  await expectDrawn(page, reply.locator(".diagram-block"), "pi-host");
});
