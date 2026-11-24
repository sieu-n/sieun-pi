import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "./helpers";

/**
 * The Enter that confirms a Korean syllable never sends, saves or opens. Chrome sends that keydown with isComposing true; WebKit, which the
 * Mac app renders in, can deliver it after compositionend with isComposing false and keyCode 229 (WebKit bug 165004). Every handler reads
 * both through lib/ui/keyboard.ts `composing()`. Each test makes its own room on the fixture server, and every write but a send is dropped.
 */
test.describe.configure({ timeout: 90_000 });

/** Types `ch` as an IME composition into the focused field and presses the Enter that confirms it, in WebKit's order. */
async function confirmSyllable(page: Page, ch: string): Promise<void> {
  await page.evaluate((ch) => {
    const el = document.activeElement as HTMLElement & { value?: string };
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    if (el.isContentEditable) document.execCommand("insertText", false, ch);
    else {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, `${el.value}${ch}`);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertCompositionText", isComposing: true }));
    }
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: ch }));
    const enter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: false });
    Object.defineProperty(enter, "keyCode", { get: () => 229 });
    el.dispatchEvent(enter);
  }, ch);
}

/** Records every write and drops all but sends, so a save the test expects not to happen stores nothing even when it does. */
async function recordWrites(page: Page): Promise<string[]> {
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    if (["GET", "HEAD"].includes(req.method())) return route.fallback();
    if (/\/read$/.test(req.url())) return route.fallback();
    writes.push(`${req.method()} ${new URL(req.url()).pathname} ${req.postData() ?? ""}`);
    return /\/send$/.test(req.url()) ? route.fallback() : route.abort();
  });
  return writes;
}

async function channel(page: Page, members: string[] = []): Promise<{ id: string; name: string }> {
  const res = await page.request.post("/api/rooms", { data: { kind: "channel", name: `ime-${tag()}`, members, test: true } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; name: string };
}

test("the confirming Enter of a Korean syllable sends nothing from the composer or the thread reply box, and the next Enter sends", async ({ page }) => {
  const room = await channel(page);
  const root = (await (await page.request.post(`/api/c/${room.id}/send`, { data: { text: "quiet root", requestId: crypto.randomUUID() } })).json()) as { item: { id: string } };
  const writes = await recordWrites(page);
  await open(page, `#/c/${room.id}`);
  const sent = (text: string) => writes.filter((w) => w.includes("/send") && w.includes(text));

  const composer = page.locator("section.conversation").getByTestId("composer-input").last();
  await composer.click();
  await page.keyboard.insertText("quiet 안녕하세");
  await confirmSyllable(page, "요");
  await page.waitForTimeout(500);
  expect(sent("quiet 안녕하세요")).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => sent("quiet 안녕하세요").length).toBe(1);

  const post = page.locator(`section.conversation [data-message-id="${root.item.id}"]`);
  await post.hover();
  await post.getByRole("button", { name: "Reply in thread" }).click();
  const reply = page.getByTestId("thread-pane").getByTestId("composer-input");
  await reply.click();
  await page.keyboard.insertText("quiet 스레드 답");
  await confirmSyllable(page, "장");
  await page.waitForTimeout(500);
  expect(sent("quiet 스레드 답장")).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => sent("quiet 스레드 답장").length).toBe(1);
});

test("the confirming Enter in Find members opens no member, and the next Enter opens the first match", async ({ page }) => {
  const t = tag();
  const make = async (name: string) => (await (await page.request.post("/api/agents", { data: { name, test: true } })).json()) as { id: string };
  const korean = await make(`검색 도우미 ${t}`);
  const others = await Promise.all(Array.from({ length: 7 }, (_, n) => make(`zz helper ${n} ${t}`)));
  const room = await channel(page, [korean.id, ...others.map((o) => o.id)]);
  await open(page, `#/c/${room.id}`);
  await page.getByTestId("channel-members").click();
  const find = page.getByRole("searchbox", { name: "Find members" });
  await find.click();
  await page.keyboard.insertText("검");
  await confirmSyllable(page, "색");
  await page.waitForTimeout(500);
  await expect(find).toBeVisible();
  expect(page.url()).toContain(room.id);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.url()).not.toContain(room.id);
});

test("the confirming Enter saves no channel description, Solo agenda or new board step", async ({ page }) => {
  const room = await channel(page);
  const solo = (await (await page.request.post("/api/rooms", { data: { kind: "solo", agenda: `IME agenda ${tag()}`, members: ["ag_vent"] } })).json()) as { id: string };
  const writes = await recordWrites(page);
  const wrote = (text: string) => writes.filter((w) => w.includes(text));

  await open(page, `#/c/${room.id}`);
  await page.locator("section.conversation").getByTestId("channel-title-button").click();
  const dialog = page.getByRole("dialog", { name: `#${room.name}` });
  await dialog.getByRole("button", { name: "Add a description" }).click();
  await dialog.getByRole("textbox", { name: "Description" }).click();
  await page.keyboard.insertText("설명 문");
  await confirmSyllable(page, "장");
  await page.waitForTimeout(500);
  expect(wrote("설명 문장")).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => wrote("설명 문장").length).toBe(1);
  await page.keyboard.press("Escape");

  await open(page, `#/c/${solo.id}`);
  await page.getByTestId("solo-agenda").hover();
  await page.getByRole("button", { name: "Edit agenda" }).first().click();
  const agenda = page.getByTestId("solo-agenda-field");
  await agenda.fill("");
  await page.keyboard.insertText("오늘 할 ");
  await confirmSyllable(page, "일");
  await page.waitForTimeout(500);
  expect(wrote("오늘 할 일")).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => wrote("오늘 할 일").length).toBe(1);

  await page.goto("/#/board/ag_crawler-vp");
  await page.getByRole("button", { name: "Add step" }).first().click();
  await page.getByRole("textbox", { name: "New step" }).click();
  await page.keyboard.insertText("새 단");
  await confirmSyllable(page, "계");
  await page.waitForTimeout(500);
  expect(wrote("새 단계")).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => wrote("새 단계").length).toBe(1);
});
