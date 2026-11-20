import { expect, test, type Page } from "@playwright/test";
import { tag } from "./helpers";

/**
 * A wide table or code block in a narrow pane stays one visible unit (owner, 11-20, #sw-factory-build p59: "does this feel like slack to
 * you?" over a thread pane that cut a 4-column table on three sides). The table the owner saw is sent into a channel thread, and the
 * thread pane is drawn 360 px wide in his 1512 x 945 window.
 */
const WIDE_TABLE = [
  "Sorry, here is the setup now, five pieces over Google's 211 guides.",
  "",
  "| Piece | Where it lives | Who reads it | What it says |",
  "|---|---|---|---|",
  "| Prime skill | sieun-pi `skills/modern-web-guidance`, linked into every box's skill folder | every agent session lists it | Google's flow, search a guide, read it, build with it, name it in the commit |",
  "| Repo skill | `.agents/skills/stack/modern-web-guidance/SKILL.md` | agents in this repo | covers search, admin, api portal, blog, demo, shared UI, Chrome extension, plus 6 rules from the sweep |",
  "| Skill map row | `repo/skill-creation/references/skill-map.md` | agents picking a repo skill | use it for any HTML, CSS or browser JS |",
  "| Frontend workflow line | `workflows/frontend-implementation` | every UI build | load the skill, look up a guide per UI pattern |",
  "| CLI | installed on us-metal02, `npx` on the Mac | both skills | `search`, `retrieve`, `legacy-scan` |",
  "",
  "The 6 repo rules are Korean typing never sends on Enter, right-sized images, one high-priority image, popups inside modals, keyboard-reachable rows, and no scan in CI.",
].join("\n");
const WIDE_CODE = "```bash\nnode scripts/release-apps-chat.mjs 87fe1c7a --verbose --check-only --boot-timeout=90 --data-dir=/home/sieun/.pi/agent/chat --socket=/run/user/1001/pi-host/host.sock --listen 127.0.0.1\n```";

test.use({ viewport: { width: 1512, height: 945 } });

/** A fresh channel whose root post has the table and the code block as thread replies, and the table again as a post, opened with its thread pane 360 px wide. */
async function openWideThread(page: Page): Promise<ReturnType<Page["locator"]>> {
  const room = (await (await page.request.post("/api/rooms", { data: { kind: "channel", name: `wide-${tag()}` } })).json()) as { id: string };
  const send = async (text: string, threadRoot?: string) =>
    ((await (await page.request.post(`/api/c/${room.id}/send`, { data: { text, threadRoot, requestId: crypto.randomUUID() } })).json()) as { item: { id: string } }).item.id;
  const root = await send("Where does the guidance skill live?");
  await send(WIDE_TABLE, root);
  await send(WIDE_CODE, root);
  await send(WIDE_TABLE);
  await page.addInitScript(() => localStorage.setItem("chat.sidePanelWidth", "360"));
  await page.goto(`/#/c/${room.id}?thread=${root}`);
  const pane = page.getByTestId("side-panel");
  await expect(pane.locator(".table-wrap")).toBeVisible({ timeout: 15_000 });
  return pane;
}

test("a wide table in a 360 px thread pane shows every row, keeps each column readable and scrolls sideways under a pinned first column", async ({ page }) => {
  const pane = await openWideThread(page);
  const wrap = pane.locator(".table-wrap");
  const box = await wrap.evaluate((el) => ({ overflowY: el.scrollHeight - el.clientHeight, sideways: el.scrollWidth - el.clientWidth }));
  expect(box.overflowY, "no inner vertical clip").toBe(0);
  expect(box.sideways, "the table scrolls sideways").toBeGreaterThan(100);
  await expect(wrap.locator("tbody tr")).toHaveCount(5);
  // Each column keeps its floor: a short label column 6rem, a sentence column 11rem, so no column runs a word a line.
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const widths = await wrap.locator("thead th").evaluateAll((ths) => ths.map((th) => [th.className, th.getBoundingClientRect().width]));
  expect(widths.map(([cls]) => cls)).toEqual(["col-short", "col-long", "col-long", "col-long"]);
  for (const [cls, width] of widths as [string, number][]) expect(width, cls).toBeGreaterThanOrEqual((cls === "col-long" ? 11 : 6) * rem);
  // "Prime skill" sits on one line, where the old pane broke it into "Prim / e / skill".
  const lines = await wrap.locator("tbody td").first().evaluate((td) => {
    const range = document.createRange();
    range.selectNodeContents(td);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBe(1);
  await wrap.evaluate((el) => (el.scrollLeft = 200));
  const [wrapLeft, firstLeft] = await Promise.all([
    wrap.evaluate((el) => el.getBoundingClientRect().left + el.clientLeft),
    wrap.locator("tbody td").first().evaluate((td) => td.getBoundingClientRect().left),
  ]);
  expect(Math.abs(firstLeft - wrapLeft), "the first column stays pinned").toBeLessThan(1.5);
  // The cut edge fades while there is more to the right.
  expect(await wrap.evaluate((el) => getComputedStyle(el).maskImage)).toMatch(/linear-gradient\(to left/);
  const fade = async () => wrap.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-end-fade")));
  expect(await fade()).toBeGreaterThan(20);
  await wrap.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect.poll(fade).toBe(0);
});

test("the open button of a table that scrolls shows without a hover and opens the whole table in the viewer", async ({ page }) => {
  const pane = await openWideThread(page);
  const button = pane.getByRole("button", { name: "Open table" });
  await page.mouse.move(5, 5);
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await button.click();
  await expect(page).toHaveURL(/view=block%3A/);
  const viewer = page.getByTestId("artifact-viewer");
  await expect(page.getByRole("dialog", { name: "Table" })).toContainText("4 columns, 5 rows");
  const wrap = viewer.locator(".table-wrap");
  await expect(wrap.locator("tbody tr")).toHaveCount(5);
  expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth), "the whole table fits the sheet").toBeLessThanOrEqual(0);
  await expect(viewer.getByRole("button", { name: "Open table" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(page).not.toHaveURL(/view=/);
});

test("a wide code block fades at its cut edge and opens in the viewer with its long lines wrapped", async ({ page }) => {
  const pane = await openWideThread(page);
  const code = pane.locator(".code-block").last();
  const pre = code.locator("pre");
  expect(await pre.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100);
  expect(await pre.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-end-fade")))).toBeGreaterThan(20);
  await code.getByRole("button", { name: "Open" }).click();
  const viewer = page.getByTestId("artifact-viewer");
  await expect(page.getByRole("dialog", { name: "Code" })).toBeVisible();
  const big = viewer.locator("pre");
  await expect(big).toContainText("--listen 127.0.0.1");
  expect(await big.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test("the same table in the channel's wide column fits with its cells wrapped, and its open button waits for a hover", async ({ page }) => {
  await openWideThread(page);
  const block = page.locator("section.conversation .table-block").last();
  await block.scrollIntoViewIfNeeded();
  expect(await block.locator(".table-wrap").evaluate((el) => [el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight])).toEqual([0, 0]);
  const button = block.getByRole("button", { name: "Open table" });
  await page.mouse.move(5, 5);
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  await block.hover();
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});
