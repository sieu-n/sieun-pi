import { expect, test, type Page, type Route } from "@playwright/test";
import { open as openRoom, row, tag } from "../channel/helpers.ts";

/**
 * The wiki pane edits a page in place, lists the posts that shared it, and turns a link to a page the wiki lacks into a search or a new
 * page (lib/shell/wiki-page.ts). A post's card for a missing page says so before it is opened (lib/ui/LinkCards.svelte). The wiki is mocked
 * per test, so no spec writes to the real wiki.
 */
const PATH = "sessions/2026/11/22/edit-me.html";
const MISSING = "sessions/2026/11/22/not-written-yet";
const RAW = `<!--wiki\n{"title":"Edit me"}\n-->\n<h1>Edit me</h1>\n<p>First line of the page.</p>\n`;

const page = (title: string, prose: string) => `<!doctype html><html><head><title>${title} · llm-wiki</title></head><body><div class="body"><article class="page">
<header class="page-head"><h1>${title}</h1></header><div class="page-grid"><div class="prose">${prose}</div>
<aside class="rail"><section class="rail-card"><h2>Backlinks <span class="badge">0</span></h2><p class="muted small">No pages link here yet.</p></section></aside>
</div></article></div></body></html>`;

type Wiki = { stored: Map<string, string>; writes: { method: string; path: string; body: Record<string, unknown> }[]; version: number };

/** A wiki of `stored` pages behind /wiki: the page view, `?format=html`, the md head with its version, and PUT and POST writes. */
async function mockWiki(p: Page, stored: Record<string, string>): Promise<Wiki> {
  const wiki: Wiki = { stored: new Map(Object.entries(stored)), writes: [], version: 3 };
  await p.route((url) => url.pathname.startsWith("/wiki/"), async (route: Route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ""));
    const method = route.request().method();
    const found = wiki.stored.get(path) ?? wiki.stored.get(`${path}.html`);
    if (method === "PUT" || method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      wiki.writes.push({ method, path, body });
      wiki.stored.set(path, String(body.content));
      wiki.version += 1;
      return route.fulfill({ status: method === "POST" ? 201 : 200, json: { path, version: wiki.version, changed: true } });
    }
    const format = url.searchParams.get("format");
    if (found === undefined) return route.fulfill(format ? { status: 404, json: { error: "Page not found" } } : { status: 404, contentType: "text/html", body: "<!doctype html><html><head><title>404 · llm-wiki</title></head><body><h1>404</h1><a href='/'>Back to home</a></body></html>" });
    if (format === "html") return route.fulfill({ contentType: "text/html", body: found });
    if (format === "md") return route.fulfill({ contentType: "text/markdown", body: `---\npath: "${path}"\nversion: ${wiki.version}\ntitle: "Edit me"\n---\n` });
    const title = /<h1>(.*?)<\/h1>/.exec(found)?.[1] ?? "Page";
    return route.fulfill({ contentType: "text/html", body: page(title, found.replace(/^<!--wiki[\s\S]*?-->\s*/, "").replace(/<h1>.*?<\/h1>/, "")) });
  });
  await p.route("**/api/pages/shared?*", (route) => route.fulfill({ json: [{ room: "ch_general", post: "p1", author: "owner", at: Date.now() - 60_000, snippet: "the plan is on the edit me page" }] }));
  return wiki;
}

async function openPage(p: Page, path: string) {
  await p.goto(`/#/c/ch_general?view=${encodeURIComponent(`wiki:${path}`)}`);
  const pane = p.getByTestId("side-panel").filter({ has: p.getByTestId("artifact-viewer") });
  await expect(pane).toBeVisible({ timeout: 15_000 });
  return pane;
}

test("Edit turns the page editable in the pane, Save stores it with its base version, and Undo writes the page as it was", async ({ page: p }) => {
  const wiki = await mockWiki(p, { [PATH]: RAW });
  const pane = await openPage(p, PATH);
  const frame = pane.locator("iframe.wiki-frame").contentFrame();
  await expect(frame.locator(".prose")).toContainText("First line of the page.");
  await pane.locator("[data-wiki-edit]").click();
  const prose = frame.locator(".prose[contenteditable=true]");
  await expect(prose.locator("h1")).toHaveText("Edit me");
  await expect(pane.locator("[data-wiki-save]")).toBeDisabled();
  await prose.locator("p").click();
  await p.keyboard.press("End");
  await p.keyboard.type(" Added in place.");
  await expect(pane.locator("[data-wiki-save]")).toBeEnabled();
  await p.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => wiki.writes.length).toBe(1);
  expect(wiki.writes[0]).toMatchObject({ method: "PUT", path: PATH, body: { baseVersion: 3 } });
  expect(String(wiki.writes[0]!.body.content)).toContain("First line of the page. Added in place.");
  expect(String(wiki.writes[0]!.body.content)).toMatch(/^<!--wiki\n\{"title":"Edit me"\}\n-->\n<h1>Edit me<\/h1>/);
  await expect(frame.locator(".prose")).not.toHaveAttribute("contenteditable", "true");
  await expect(frame.locator(".prose")).toContainText("Added in place.");
  const toast = p.getByRole("region", { name: "Notifications" }).locator(".toast").filter({ hasText: "Page saved" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => wiki.writes.length).toBe(2);
  expect(wiki.writes[1]!.body).toMatchObject({ content: RAW, baseVersion: 4 });
  await expect(frame.locator(".prose")).not.toContainText("Added in place.");
});

test("a new first heading renames the page, and Esc in an unchanged edit leaves it without a write", async ({ page: p }) => {
  const wiki = await mockWiki(p, { [PATH]: RAW });
  const pane = await openPage(p, PATH);
  const frame = pane.locator("iframe.wiki-frame").contentFrame();
  await pane.locator("[data-wiki-edit]").click();
  const prose = frame.locator(".prose[contenteditable=true]");
  await prose.locator("h1").click();
  await p.keyboard.press("Escape");
  await expect(frame.locator(".prose")).not.toHaveAttribute("contenteditable", "true");
  expect(wiki.writes).toHaveLength(0);
  await expect(pane).toBeVisible();
  await pane.locator("[data-wiki-edit]").click();
  await frame.locator(".prose[contenteditable=true] h1").click();
  await p.keyboard.press("End");
  await p.keyboard.type(" again");
  await pane.locator("[data-wiki-save]").click();
  await expect.poll(() => wiki.writes.length).toBe(1);
  expect(String(wiki.writes[0]!.body.content)).toMatch(/^<!--wiki\n\{"title":"Edit me again"\}\n-->\n<h1>Edit me again<\/h1>/);
  await expect(pane.locator(".wiki-title")).toHaveText("Edit me again");
});

test("the page's side rail lists the posts that shared it, and a row opens that post", async ({ page: p }) => {
  await mockWiki(p, { [PATH]: RAW });
  const pane = await openPage(p, PATH);
  const card = pane.locator("iframe.wiki-frame").contentFrame().locator("[data-chat-shared]");
  await expect(card.locator("h2")).toHaveText("Shared in 1");
  await expect(card.locator("a")).toContainText("#general · You");
  await expect(card.locator("a")).toContainText("the plan is on the edit me page");
  await card.locator("a").click();
  await expect(p).toHaveURL(/#\/c\/ch_general\?m=p1/);
});

test("a page the wiki lacks offers a search by its name and Create page, which writes it and opens it for editing", async ({ page: p }) => {
  const wiki = await mockWiki(p, { [PATH]: RAW });
  const pane = await openPage(p, MISSING);
  const missing = pane.locator("[data-wiki-missing]");
  await expect(missing).toContainText("This page doesn't exist");
  await expect(pane.locator("[data-wiki-edit]")).toHaveCount(0);
  await missing.getByRole("button", { name: /Search for/ }).click();
  const field = p.locator("[data-search-palette] input");
  await expect(field).toHaveValue("Not written yet");
  while (await field.isVisible()) await p.keyboard.press("Escape");
  await missing.getByRole("button", { name: "Create page" }).click();
  await expect.poll(() => wiki.writes.length).toBe(1);
  expect(wiki.writes[0]).toMatchObject({ method: "POST", path: `${MISSING}.html` });
  const frame = pane.locator("iframe.wiki-frame").contentFrame();
  await expect(frame.locator(".prose[contenteditable=true] h1")).toHaveText("Not written yet");
  await expect(missing).toHaveCount(0);
});

test("a post's card for a wiki page that does not exist reads Page not found before it is opened", async ({ page: p, request }) => {
  await p.route((url) => url.pathname.startsWith("/wiki/"), (route) => {
    const url = new URL(route.request().url());
    return url.pathname.includes("gone-page")
      ? route.fulfill({ status: 404, json: { error: "Page not found" } })
      : route.fulfill({ contentType: "text/markdown", body: `---\ntitle: "Real page"\nsummary: "It exists."\n---\n` });
  });
  const text = `cards ${tag()}: wiki:sessions/2026/11/22/real-page.html and wiki:sessions/2026/11/22/gone-page.html`;
  const id = ((await (await request.post("/api/c/dm_vent/send", { data: { text, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } }).item.id;
  await openRoom(p, "#/c/dm_vent");
  const cards = row(p, id).locator("[data-wiki-card]");
  await expect(cards).toHaveCount(2, { timeout: 15_000 });
  await expect(cards.nth(0)).toContainText("Real page");
  await expect(cards.nth(0)).not.toHaveClass(/missing/);
  await expect(cards.nth(1)).toHaveClass(/missing/);
  await expect(cards.nth(1)).toContainText("Page not found");
  await expect(cards.nth(1)).toContainText("Nothing is at sessions/2026/11/22/gone-page.html");
});
