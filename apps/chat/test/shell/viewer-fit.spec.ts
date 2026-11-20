import { expect, test, type Page } from "@playwright/test";

/**
 * The artifact viewer is a panel inside the window at every window and interface size, in the browser and in the Mac app (apps/desktop),
 * whose window buttons sit in the top bar. The owner saw it run past the window's top and bottom edges in the Mac app, because the sheet
 * was 100vh tall and the interface size's root zoom multiplies vh. A wiki page in it shows no wiki chrome or page header of its own and
 * takes the app's colours.
 */
const WINDOWS = [
  { width: 1512, height: 945 },
  { width: 1180, height: 720 },
];
const SCALES = [1, 1.2, 1.5];
const WIKI = "sessions/2026/11/20/viewer-fit.md";

/** A wiki page shaped like apps/wiki's: its own light colours, top bar, page header and prose. */
const PAGE = `<!doctype html><html><head><title>Viewer fit · llm-wiki</title><style>
:root { --bg: #f6f7f8; --surface: #ffffff; --ink: #16211f; --border: #dfe5e2; background: var(--bg); color: var(--ink); }
body { margin: 0; background: var(--bg); } .prose { color: #21302c; }
</style></head><body><div class="shell"><header class="topbar">llm-wiki</header><div class="body"><aside class="tree-rail">tree</aside>
<div class="content"><article class="page"><header class="page-head"><p class="crumbs">${WIKI}</p><div class="page-title-row"><h1>Viewer fit</h1><a href="/wiki/edit/x">Edit</a></div></header>
<div class="page-grid"><div class="prose"><p>Body text of the page.</p></div></div></article></div></div></div></body></html>`;

async function open(page: Page, scale: number, mode: "light" | "dark", desktop: boolean) {
  await page.addInitScript(([value, colorMode, mac]) => {
    if (window !== window.top) return;
    if (value === 1) localStorage.removeItem("chat.interfaceScale");
    else localStorage.setItem("chat.interfaceScale", String(value));
    localStorage.setItem("chat.colorMode", colorMode);
    if (mac) Object.assign(window, { __TAURI_INTERNALS__: {} });
  }, [scale, mode, desktop] as const);
  await page.route("**/wiki/**", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto(`/#/c/ch_general?view=${encodeURIComponent(`wiki:${WIKI}`)}`);
  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("artifact-viewer") });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return dialog;
}

for (const size of WINDOWS) {
  for (const scale of SCALES) {
    for (const desktop of [false, true]) {
      test(`${size.width}x${size.height} at ${Math.round(scale * 100)}%${desktop ? " in the Mac app" : ""}: the viewer sits inside the window under the top bar`, async ({ page }) => {
        await page.setViewportSize(size);
        const dialog = await open(page, scale, "light", desktop);
        const box = (await dialog.boundingBox())!;
        const bar = (await page.locator("header.topbar").boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height - 8);
        // The Mac app's window buttons cover x 20 to 80 and y 16 to 40, which the viewer stays clear of.
        if (desktop) expect(box.y).toBeGreaterThanOrEqual(40);
        const close = (await dialog.getByRole("button", { name: "Close" }).boundingBox())!;
        expect(close.x + close.width).toBeLessThanOrEqual(box.x + box.width);
      });
    }
  }
}

test("the viewer has one header with the page title and no path line, and the page drops its own header", async ({ page }) => {
  const dialog = await open(page, 1, "light", false);
  await expect(dialog.getByRole("heading", { name: "Viewer fit" })).toBeVisible();
  await expect(dialog.locator(".dialog-header p")).toHaveCount(0);
  const frame = dialog.locator("iframe.wiki-frame").contentFrame();
  await expect(frame.locator(".prose")).toBeVisible();
  for (const hidden of [".page-head", ".topbar", ".tree-rail"]) await expect(frame.locator(hidden)).toBeHidden();
});

test("a wiki page in the viewer takes the app's colours and follows a change of colour mode", async ({ page }) => {
  const dialog = await open(page, 1, "dark", false);
  const frame = dialog.locator("iframe.wiki-frame");
  await expect(frame).toHaveCSS("opacity", "1");
  const colours = () =>
    frame.evaluate((el: HTMLIFrameElement) => {
      const doc = el.contentDocument!;
      const app = getComputedStyle(document.documentElement);
      return {
        page: getComputedStyle(doc.body).backgroundColor,
        text: getComputedStyle(doc.querySelector(".prose")!).color,
        scheme: getComputedStyle(doc.documentElement).colorScheme,
        app: app.getPropertyValue("--surface-popover").trim(),
      };
    });
  await expect.poll(colours).toEqual({ page: "rgb(40, 40, 40)", text: "rgb(255, 255, 255)", scheme: "dark", app: "#282828" });
  await page.evaluate(() => (document.documentElement.dataset.colorMode = "light"));
  await expect.poll(colours).toEqual({ page: "rgb(255, 255, 255)", text: "rgb(15, 15, 15)", scheme: "light", app: "#ffffff" });
});

test("Esc and a click outside the viewer close it", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  let dialog = await open(page, 1.2, "light", true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/view=/);
  dialog = await open(page, 1.2, "light", true);
  await page.mouse.click(8, 600);
  await expect(dialog).toBeHidden();
});
