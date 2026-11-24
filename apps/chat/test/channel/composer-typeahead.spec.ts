import { expect, test } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open, tag } from "./helpers";

/** The composer's emoji button, its `:name` list and its `/` commands (Composer.svelte, typeahead.ts). */

test(":thu opens the emoji list, a pick puts the emoji in the draft, and a whole :name: turns into its emoji", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("nice :thu");
  const option = page.getByRole("option", { name: /:thumbsup:/ }).first();
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(option).toBeHidden();
  await expect(input).toContainText("nice 👍");
  await page.keyboard.type("and :tada:");
  await expect(input).toContainText("and 🎉");
  await page.keyboard.type(" at 10:30");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("the emoji button opens the picker and its pick lands at the caret", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  // The dev rig's "A new version of the chat is out" toast sits over the composer's left tools while other files change.
  await page.addStyleTag({ content: ".toaster { display: none !important; }" });
  await page.keyboard.type("ab");
  await page.keyboard.press("ArrowLeft");
  await conversation(page).getByTestId("composer-emoji").click();
  const search = page.getByRole("combobox", { name: "Search emoji" });
  await expect(search).toBeFocused();
  await search.fill("rocket");
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
  await expect(input).toHaveText("a🚀b");
  await expect(input).toBeFocused();
});

test("/ lists the room's commands, /topic sets the description, and an unknown command keeps the draft", async ({ page, request }) => {
  const word = tag();
  const created = await request.post("/api/rooms", { data: { kind: "channel", name: `slash-${word}`, members: [], test: true } });
  const { id } = (await created.json()) as { id: string };
  await open(page, `#/c/${id}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("/");
  await expect(page.getByRole("option", { name: /\/topic/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /\/rename/ })).toBeVisible();
  await page.keyboard.type("to");
  await page.keyboard.press("Enter");
  await expect(input).toHaveText(/^\/topic\s$/);
  let posted = false;
  page.on("request", (r) => {
    if (r.url().includes(`/api/c/${id}/send`)) posted = true;
  });
  await page.keyboard.type(`Builds ${word}`);
  await page.keyboard.press("Enter");
  await expect(conversation(page).getByTestId("channel-purpose")).toHaveText(`Builds ${word}`);
  await expect(input).toHaveText("");
  await page.keyboard.type("/nope x");
  await page.keyboard.press("Enter");
  await expect(page.getByText("/nope is not a command here")).toBeVisible();
  await expect(input).toHaveText("/nope x");
  expect(posted).toBe(false);
  await request.patch(`/api/rooms/${id}`, { data: { archived: true } });
});

test("a draft that starts with a path still posts", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`/home/sieun/src ${tag()}`);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`));
  await page.keyboard.press("Enter");
  expect(((await sent).postDataJSON() as { text: string }).text.startsWith("/home/sieun/src")).toBe(true);
});

test("/invite @agent adds it, /remove @agent takes it out with Undo, and /archive archives the channel", async ({ page, request }) => {
  const created = await request.post("/api/rooms", { data: { kind: "channel", name: `slash-members-${tag()}`, members: [], test: true } });
  const { id } = (await created.json()) as { id: string };
  await open(page, `#/c/${id}`);
  const input = composerInput(conversation(page));
  const count = page.getByTestId("channel-members");
  const before = await count.getAttribute("aria-label");
  await input.click();
  await page.keyboard.type("/invite @Ven");
  await page.getByRole("option", { name: /^Vent/ }).click();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Added Vent to #slash-members/)).toBeVisible();
  await expect(count).not.toHaveAttribute("aria-label", before ?? "");
  await page.keyboard.type("/remove @Ven");
  await page.getByRole("option", { name: /^Vent/ }).click();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Removed Vent from #slash-members/)).toBeVisible();
  await expect(count).toHaveAttribute("aria-label", before ?? "");
  await page.keyboard.type("/archive");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Archived #slash-members/)).toBeVisible();
});

test("/remind me <what> <when> sets a reminder of his own text, and Saved lists it under Reminder", async ({ page, request }) => {
  const word = tag();
  const created = await request.post("/api/rooms", { data: { kind: "channel", name: `slash-remind-${word}`, members: [], test: true } });
  const { id } = (await created.json()) as { id: string };
  await open(page, `#/c/${id}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("/remind me sometime");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Say what and when/)).toBeVisible();
  await expect(input).toHaveText("/remind me sometime");
  await input.evaluate((e) => { e.textContent = ""; e.dispatchEvent(new InputEvent("input", { bubbles: true })); });
  await page.keyboard.type(`/remind me call the bank ${word} in 20 min`);
  const before = Date.now();
  await page.keyboard.press("Enter");
  // From 23:40 the 20 minutes cross midnight and the toast says "tomorrow at 12:05 AM" (lib/remind.ts whenPhrase), so the spec reads
  // the toast, then checks its words against the day and time of the remindAt the server stored.
  const toast = page.getByText(/We'll remind you /);
  await expect(toast).toBeVisible();
  const said = await toast.textContent();
  await expect(input).toHaveText("");
  const list = (await (await request.get("/api/later?state=open")).json()) as { items: { id: string; text: string; remindAt?: number; room?: string }[] };
  const item = list.items.find((i) => i.text === `call the bank ${word}`)!;
  expect(item.room).toBeUndefined();
  expect(item.remindAt! - Date.now()).toBeGreaterThan(18 * 60_000);
  const expected = await page.evaluate(({ at, before }) => {
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(at);
    return new Date(at).toDateString() === new Date(before).toDateString() ? `We'll remind you at ${time}` : `We'll remind you tomorrow at ${time}`;
  }, { at: item.remindAt!, before });
  expect(said).toContain(expected);
  await open(page, "#/c/saved", "later-page");
  const row = page.locator(`[data-later-id="${item.id}"]`);
  await expect(row).toContainText(`call the bank ${word}`);
  await expect(row.locator("[data-later-note]")).toHaveText("Reminder");
  await request.delete(`/api/later/${encodeURIComponent(item.id)}`);
  await request.patch(`/api/rooms/${id}`, { data: { archived: true } });
});
