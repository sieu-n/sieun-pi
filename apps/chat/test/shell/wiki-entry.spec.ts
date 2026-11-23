import { expect, test, type Page } from "@playwright/test";

/**
 * The wiki is one click away and Cmd K finds its pages: the Messages sidebar's Wiki row opens the Wiki view with the favorites and the pages
 * updated last, its field finds a page by title, a row opens the page in the viewer, and Cmd K lists a page whose title is typed above the
 * messages. GET /api/pages and the wiki frame are stubbed, so the spec reads no live wiki.
 */
const IDEAL = "agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html";
const TITLE = "Ideal Slack replies in sw factory rooms";
const row = (path: string, title: string, description: string | null = null) => ({ path, title, description, updated: "2026-11-20T10:00:00Z" });
const HOME = { query: "", favorites: [row("domains/deployment/production-runbook.html", "Production runbook")], pages: [row("domains/devops/sw-factory-threads/index.html", "sw factory threads", "What Solo, Agent and Job mean."), row(IDEAL, TITLE, "Seventeen real before and after pairs.")] };
const FOUND = { query: TITLE, favorites: [], pages: [row(IDEAL, TITLE, "Seventeen real before and after pairs."), row("domains/devops/sw-factory-threads/channel-thread.html", "Channel reply prefill")] };

async function stub(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route(url => url.pathname === "/api/pages", route => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    asked.push(q);
    return route.fulfill({ json: q ? (q.toLowerCase().startsWith("ideal") ? { ...FOUND, query: q } : { query: q, favorites: [], pages: [] }) : HOME });
  });
  // Only the frame's own /wiki/<path>: a glob of **/wiki/** also caught the dev build's src/pages/wiki modules.
  await page.route(url => url.pathname.startsWith("/wiki/"), route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><article class="page"><div class="prose"><h1>${TITLE}</h1></div></article></body></html>` }));
  return asked;
}

test("the sidebar's Wiki row opens the favorites and recent pages, and a row opens its page in the viewer", async ({ page }) => {
  await stub(page);
  await page.goto("/#/c/ch_general");
  await page.getByRole("link", { name: "Wiki", exact: true }).click();
  await expect(page).toHaveURL(/#\/c\/wiki$/);
  const view = page.getByTestId("wiki-page");
  await expect(view.locator("[data-wiki-section]")).toHaveText(["Favorites", "Recently updated"]);
  await expect(view.locator(`[data-wiki-page-row="${IDEAL}"]`)).toContainText("agent factory job · slack style replies");
  await view.locator(`[data-wiki-page-row="${IDEAL}"]`).click();
  await expect(page).toHaveURL(new RegExp(`view=wiki%3A${encodeURIComponent(IDEAL).replace(/%2F/g, "%2F")}`));
  await expect(page.getByTestId("artifact-viewer")).toBeVisible();
});

test("the Wiki view's field finds a page by its title, keeps the words in the address, and says when nothing matches", async ({ page }) => {
  await stub(page);
  await page.goto("/#/c/wiki");
  const view = page.getByTestId("wiki-page");
  await view.getByRole("searchbox", { name: "Search pages" }).fill(TITLE);
  await expect(view.locator("[data-wiki-section]")).toHaveText("2 pages");
  await expect(view.locator("[data-wiki-page-row]").first()).toHaveAttribute("data-wiki-page-row", IDEAL);
  await expect(page).toHaveURL(/q=Ideal\+Slack/);
  await view.getByRole("searchbox", { name: "Search pages" }).fill("zzz nothing");
  await expect(view.getByText("No pages match “zzz nothing”")).toBeVisible();
  await expect(view.getByRole("button", { name: "Open wiki home" })).toBeVisible();
});

test("Cmd K lists a page whose title is typed above the messages, and Enter on it opens the page", async ({ page }) => {
  await stub(page);
  await page.goto("/#/c/ch_general");
  // main.ts mounts the app, and with it the window's Cmd K listener, only after restorePages, which can end after the load event.
  await expect(page.getByTestId("nav-capsule")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.locator("[data-search-palette]");
  await dialog.getByRole("combobox").fill(TITLE);
  const pages = dialog.locator('[data-group="Pages"]');
  await expect(pages.getByRole("option")).toHaveCount(2);
  await expect(pages.getByRole("option").first()).toContainText(TITLE);
  const groups = await dialog.locator("[data-group]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-group")));
  expect(groups.indexOf("Pages")).toBeLessThan(groups.indexOf("Messages"));
  await pages.getByRole("option").first().hover();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/view=wiki%3Aagents/);
  await expect(page.getByTestId("artifact-viewer")).toBeVisible();
});

test("the full results page has a Pages tab that lists the matching pages, a title match first", async ({ page }) => {
  await stub(page);
  await page.goto(`/#/search?q=${encodeURIComponent(TITLE)}`);
  const tabs = page.getByRole("tablist", { name: "Result types" });
  await expect(tabs.getByRole("tab", { name: /Pages/ })).toContainText("2");
  await tabs.getByRole("tab", { name: /Pages/ }).click();
  await expect(page).toHaveURL(/tab=pages/);
  const rows = page.locator("[data-search-pages] [data-wiki-page-row]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(TITLE);
  await rows.first().click();
  await expect(page.getByTestId("artifact-viewer")).toBeVisible();
});
