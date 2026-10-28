import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, CRAWLER, FRONTEND, open, tag, VENT_JOB } from "./helpers";

/** Crawler VP's seeded rich answer (server/host/fixture.ts `richReply`): the row whose bubble holds the Important callout. */
const rich = (page: Page) => conversation(page).locator("li[data-message-id]").filter({ has: page.locator(".callout-important") });

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
// The first mermaid load on a cold dev server takes up to 20 s while four workers start at once.
test.describe.configure({ timeout: 60_000 });

test("the rich answer draws its mermaid flow as an SVG in the current theme, and redraws it in dark mode", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const block = rich(page).locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  const svg = block.locator(".diagram-slot svg");
  await expect(svg).toBeVisible({ timeout: 15_000 });
  await expect(svg.getByText("Browser specs")).toBeVisible();
  expect(await svg.locator("style").first().textContent()).toContain("#f3f3f4");
  await page.evaluate(() => (document.documentElement.dataset.colorMode = "dark"));
  await expect.poll(async () => block.locator(".diagram-slot svg style").first().textContent(), { timeout: 15_000 }).toContain("#292929");
});

test("the diagram's Source shows the mermaid text, Copy copies it, and Expand opens it in the lightbox", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const block = rich(page).locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block.locator(".diagram-slot svg")).toBeVisible({ timeout: 15_000 });
  await block.getByRole("button", { name: "Source" }).click();
  await expect(block.locator("pre")).toContainText("flowchart TD");
  await expect(block.locator(".diagram-slot")).toBeHidden();
  await block.getByRole("button", { name: "Diagram" }).click();
  await expect(block.locator(".diagram-slot svg")).toBeVisible();
  await block.getByRole("button", { name: "Copy" }).click();
  await expect(block.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("specs -- pass --> ok");
  await block.getByRole("button", { name: "Expand" }).click();
  const lightbox = page.getByRole("dialog", { name: "Diagram" });
  await expect(lightbox.locator("img")).toBeVisible();
  expect(await lightbox.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(500);
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});

test("a diagram that does not parse falls back to its source with the parse error", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type(`broken diagram ${tag()}`);
  await page.keyboard.press("Enter");
  const block = conversation(page).locator(".diagram-block.diagram-failed").last();
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block.locator(".diagram-error")).toContainText("did not parse");
  await expect(block.locator("pre")).toContainText("a --> [unclosed");
  await expect(block.getByRole("button", { name: "Source" })).toHaveCount(0);
  await expect(block.getByRole("button", { name: "Copy" })).toBeVisible();
});

test("callouts get their class and title, and a plain quote stays a quote", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const important = rich(page).locator(".callout.callout-important");
  await expect(important.locator(".callout-title")).toHaveText("Important");
  await expect(important).toContainText("Say yes on the For you ask");
  await expect(important).not.toContainText("[!IMPORTANT]");
  await expect(rich(page).locator(".callout.callout-warning .callout-title")).toHaveText("Warning");
});

test("code blocks have a language label and a copy button, and a long one folds behind Show all", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const ts = rich(page).locator(".code-block").filter({ has: page.locator(".code-lang", { hasText: /^ts$/ }) });
  await ts.scrollIntoViewIfNeeded();
  await ts.getByRole("button", { name: "Copy" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("export function foldSteps");
  const fold = rich(page).locator("details");
  await fold.locator("summary").click();
  const log = fold.locator(".code-block");
  await expect(log).toHaveClass(/folded/);
  const pre = log.locator("pre");
  const folded = (await pre.boundingBox())!.height;
  expect(folded).toBeLessThan(360);
  await log.getByRole("button", { name: "Show all 24 lines" }).click();
  await expect(log).not.toHaveClass(/folded/);
  expect((await pre.boundingBox())!.height).toBeGreaterThan(folded);
  await expect(log.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
});

test("tables keep a sticky header in a scroll box, and the task list is read-only checkboxes", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const table = rich(page).locator(".table-wrap");
  await expect(table.locator("th").first()).toHaveText("Surface");
  expect(await table.locator("th").first().evaluate((th) => getComputedStyle(th).position)).toBe("sticky");
  expect(await table.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  const boxes = rich(page).locator("li.task-item input[type=checkbox]");
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(2)).not.toBeChecked();
  await expect(boxes.nth(2)).toBeDisabled();
});

test("internal links render as pills and GitHub links as cards, and the pills navigate or copy", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const row = rich(page);
  const file = row.locator(".artifact-link.path-pill");
  await expect(file).toHaveText("apps/chat/web/src/pages/board/BoardPanel.svelte:48");
  await expect(row.locator(".artifact-link.wiki-link")).toHaveText("the board panel page");
  await expect(row.locator(".artifact-link.wiki-link")).toHaveAttribute("href", /\/page\/sessions\/2026\/10\/28\/board-panel\.md$/);
  await expect(row.locator('[data-board-id="p1"]')).toBeVisible();
  const cards = row.locator(".gh-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("sieu-n/sieun-pi");
  await expect(cards.nth(0).locator(".gh-ref")).toHaveText("#42");
  await expect(cards.nth(0).locator(".gh-title")).toHaveText("Board panel redesign");
  await expect(cards.nth(1).locator(".gh-ref")).toHaveText("51e8862");
  await file.click();
  await expect(page.getByText("Path copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("apps/chat/web/src/pages/board/BoardPanel.svelte:48");
  await row.locator(".artifact-link.thread-link").click();
  await expect(page).toHaveURL(new RegExp(`#/c/${VENT_JOB.replace(":", "(:|%3A)")}`));
});

test("the screenshot loads from the box through /api/local-image and opens in the lightbox", async ({ page }) => {
  await open(page, `#/c/${CRAWLER}`);
  const img = rich(page).locator("img.md-image");
  await img.scrollIntoViewIfNeeded();
  await expect(img).toHaveAttribute("src", /^\/api\/local-image\?path=/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  await img.click();
  await expect(page.getByRole("dialog", { name: "Board panel on staging" })).toBeVisible();
});

test.describe("on a short screen", () => {
  test.use({ viewport: { width: 1440, height: 600 } });

  test("a diagram far above the view stays undrawn until it scrolls near", async ({ page }) => {
    await open(page, `#/c/${CRAWLER}`);
    const block = rich(page).locator(".diagram-block");
    await expect(block).toHaveCount(1);
    const far = await block.evaluate((el) => {
      let box: Element | null = el.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
      return !!box && el.getBoundingClientRect().bottom < box.getBoundingClientRect().top - 450;
    });
    test.skip(!far, "the diagram already sits near the view at this size");
    await expect(block.locator(".mermaid-view")).toHaveCount(0);
    await block.scrollIntoViewIfNeeded();
    await expect(block.locator(".diagram-slot svg")).toBeVisible({ timeout: 15_000 });
  });
});
