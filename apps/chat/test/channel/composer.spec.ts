import { expect, test } from "@playwright/test";
import { commThread, composerInput, conversation, FRONTEND, open, row, tag, VENT_JOB, VENT } from "./helpers";

test("Enter sends, Shift Enter adds a line, and the answer lands in a new bubble", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const word = tag();
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`first line ${word}`);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`) && r.method() === "POST");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string };
  expect(body.text).toBe(`first line ${word}\nsecond line`);
  await expect(input).toHaveText("");
  const mine = conversation(page).locator(".row.own").filter({ hasText: word });
  await expect(mine).toBeVisible();
  await expect(conversation(page).locator('[data-kind="turn"]').last()).not.toBeEmpty();
});

test("Stop ends a running answer, and the comm thread's turn reads Response stopped", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `stop ${tag()}` } })).json()) as { id: string; room: string; thread: string };
  await open(page, `#/c/${agent.room}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`slow ${tag()}`);
  await page.keyboard.press("Enter");
  const stop = page.getByTestId("stop");
  await expect(stop).toBeVisible({ timeout: 8_000 });
  const aborted = page.waitForRequest((r) => r.url().endsWith(`/api/c/${agent.room}/abort`));
  await stop.click();
  await aborted;
  await expect(stop).toBeHidden({ timeout: 8_000 });
  await open(page, `#/c/${await commThread(request, agent.id, agent.room)}`);
  await expect(conversation(page).getByText("Response stopped").last()).toBeVisible({ timeout: 8_000 });
});

test("@ opens the agent typeahead, a pick becomes a chip and a recipient, and the send routes the mention", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("ping @Ven");
  const option = page.getByRole("option", { name: /^Vent/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(input.locator("[data-chip-id]")).toHaveText("@Vent");
  await expect(conversation(page).locator(".recipients")).toBeVisible();
  await page.keyboard.type(`look at ${tag()}`);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { text: string; mentions: string[] };
  expect(body.mentions).toEqual(["ag_vent"]);
  expect(body.text.startsWith("ping @Vent")).toBe(true);
});

test("the typeahead keeps the caret: arrows move, Enter picks, and typing goes on in the composer", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type("@crawl");
  await expect(page.getByRole("option", { name: /^Crawler VP/ })).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input.locator("[data-chip-id]")).toHaveText("@Crawler VP");
  await page.keyboard.type("hello");
  await expect(input).toContainText("@Crawler VP\u00a0hello");
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("# opens the channel typeahead", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type("see #pi-cut");
  await page.getByRole("option", { name: /pi-cutover/ }).click();
  await expect(composerInput(conversation(page)).locator("[data-chip-kind=channel]")).toHaveText("#pi-cutover");
});

test("a pasted image shows as a thumbnail and goes out with the message", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  await input.evaluate((el) => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(conversation(page).locator(".thumb img")).toBeVisible();
  await page.keyboard.type(`picture ${tag()}`);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { images: { mimeType: string; data: string }[] };
  expect(body.images).toHaveLength(1);
  expect(body.images[0]!.mimeType).toBe("image/png");
  await expect(conversation(page).locator(".thumb")).toHaveCount(0);
});

test("a pasted PNG screenshot uploads as a smaller WebP and the landed message shows the bytes the page holds", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  const fetched: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET") fetched.push(new URL(r.url()).pathname);
  });
  const uploaded = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/uploads"));
  const pngSize = await input.evaluate(async (el) => {
    const canvas = new OffscreenCanvas(1600, 1000);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, 1600, 1000);
    ctx.fillStyle = "#ddd";
    ctx.font = "20px sans-serif";
    for (let y = 30; y < 1000; y += 28) ctx.fillText(`line ${y}: the quick brown fox jumps over the lazy dog 0123456789 `.repeat(3), 10, y);
    const png = await canvas.convertToBlob({ type: "image/png" });
    const data = new DataTransfer();
    data.items.add(new File([png], "shot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    return png.size;
  });
  const upload = await uploaded;
  expect(upload.headers()["content-type"]).toBe("image/webp");
  const text = `shot ${tag()}`;
  await page.keyboard.type(text);
  const sent = page.waitForResponse((r) => r.url().includes(`/api/c/${FRONTEND}/send`));
  await page.keyboard.press("Enter");
  const request = (await sent).request().postDataJSON() as { images: { url: string; mimeType: string }[] };
  expect(request.images[0]!.mimeType).toBe("image/webp");
  const kept = await page.request.get(request.images[0]!.url);
  expect(kept.headers()["content-type"]).toBe("image/webp");
  expect((await kept.body()).length).toBeLessThan(pngSize);
  const row = conversation(page).locator("[data-message-id]:not([data-message-id^='r:'])").filter({ hasText: text });
  await expect(row.locator(".images img")).toHaveAttribute("src", /^blob:/);
  expect(fetched).not.toContain(request.images[0]!.url);
});

const pasteShot = (input: import("@playwright/test").Locator) => input.evaluate(async (el) => {
  const canvas = new OffscreenCanvas(800, 500);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, 800, 500);
  ctx.fillStyle = "#ddd";
  ctx.font = "20px sans-serif";
  for (let y = 30; y < 500; y += 28) ctx.fillText(`line ${y}: the quick brown fox jumps over the lazy dog`, 10, y);
  const data = new DataTransfer();
  data.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "shot.png", { type: "image/png" }));
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});

type Sample = { m: string; p: string; ms: number; enc?: number; bg?: string };
/**
 * The page's timing lines, read from each POST /api/timings body in a route: the request event's postData of the beacon's Blob body was null
 * in two runs of the Stop job on a busy box on 11-22, and a route sees the body the page sent.
 */
const timingSamples = (page: import("@playwright/test").Page): Sample[] => {
  const samples: Sample[] = [];
  void page.route(/\/api\/timings$/, async (route) => {
    const body = route.request().postDataBuffer();
    if (route.request().method() === "POST" && body) samples.push(...((JSON.parse(body.toString()) as { samples?: Sample[] }).samples ?? []));
    await route.continue().catch(() => undefined);
  });
  return samples;
};

test("an upload that ended before Enter logs as background, with its encode time", async ({ page }) => {
  test.setTimeout(45_000);
  const samples = timingSamples(page);
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/uploads"));
  await pasteShot(input);
  await uploaded;
  await page.keyboard.type(`after upload ${tag()}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => samples.find((s) => s.p === "/api/uploads"), { timeout: 20_000 }).toBeTruthy();
  const upload = samples.find((s) => s.p === "/api/uploads")!;
  expect(upload.bg).toBe("shown");
  expect(upload.enc).toBeGreaterThanOrEqual(0);
});

type Sample2 = Sample & { stored?: number };

/** Holds every POST /api/uploads until `release()`, then for `ms` more. */
async function holdUploads(page: import("@playwright/test").Page, ms = 0): Promise<() => void> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/uploads", async (route) => {
    await released;
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined);
  });
  return release;
}

test("an image send shows its bubble at Enter while the image uploads, and its line logs Enter to bubble with the time to stored apart", async ({ page }) => {
  test.setTimeout(45_000);
  const samples = timingSamples(page) as Sample2[];
  const release = await holdUploads(page, 1200);
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  const uploading = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/uploads"));
  await pasteShot(input);
  await uploading;
  const text = `during upload ${tag()}`;
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  const bubble = conversation(page).locator("[data-message-id^='r:']").filter({ hasText: text });
  await expect(bubble.locator(".images img")).toHaveAttribute("src", /^blob:/);
  await expect(input).toHaveText("");
  await expect(conversation(page).locator(".thumb")).toHaveCount(0);
  release();
  const send = () => samples.find((s) => s.p === `/api/c/${FRONTEND}/send`);
  await expect.poll(() => send() && samples.find((s) => s.p === "/api/uploads"), { timeout: 20_000 }).toBeTruthy();
  expect(samples.find((s) => s.p === "/api/uploads")!.bg).toBe("shown");
  expect(send()!.ms).toBeLessThan(1000);
  expect(send()!.stored).toBeGreaterThanOrEqual(1200);
});

test("a text sent while the image send before it still uploads reaches the server after it", async ({ page }) => {
  const release = await holdUploads(page, 800);
  const order: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/c/${FRONTEND}/send`)) order.push((r.postDataJSON() as { text: string }).text);
  });
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  const uploading = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/uploads"));
  await pasteShot(input);
  await uploading;
  const word = tag();
  await page.keyboard.type(`first with image ${word}`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(`second text ${word}`);
  await page.keyboard.press("Enter");
  await expect(conversation(page).locator("[data-message-id^='r:']").filter({ hasText: word })).toHaveCount(2);
  await page.waitForTimeout(500);
  expect(order.filter((sent) => sent.includes(word))).toEqual([]);
  release();
  await expect.poll(() => order.filter((sent) => sent.includes(word))).toEqual([`first with image ${word}`, `second text ${word}`]);
  const landed = conversation(page).locator("[data-message-id]:not([data-message-id^='r:']).own").filter({ hasText: word });
  await expect(landed).toHaveCount(2);
  await expect(landed.first()).toContainText("first with image");
});

test("a text send's line logs Enter to bubble, with the time until the server kept it apart", async ({ page }) => {
  test.setTimeout(45_000);
  const samples = timingSamples(page) as Sample2[];
  await page.route(`**/api/c/${FRONTEND}/send`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await open(page, `#/c/${FRONTEND}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type(`slow text ${tag()}`);
  await page.keyboard.press("Enter");
  const send = () => samples.find((s) => s.p === `/api/c/${FRONTEND}/send`);
  await expect.poll(send, { timeout: 20_000 }).toBeTruthy();
  expect(send()!.ms).toBeLessThan(1000);
  expect(send()!.stored).toBeGreaterThanOrEqual(1200);
});

test("a reload while the image uploads sends the message again from the next page", async ({ page }) => {
  let hold = true;
  await page.route("**/api/uploads", async (route) => {
    if (!hold) await route.continue();
  });
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.click();
  const uploading = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/uploads"));
  await pasteShot(input);
  await uploading;
  const text = `reload mid upload ${tag()}`;
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(conversation(page).locator("[data-message-id^='r:']").filter({ hasText: text })).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve) => {
    const request = indexedDB.open("chat.heldImages");
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("images")) return resolve(0);
      const count = db.transaction("images").objectStore("images").count();
      count.onsuccess = () => resolve(count.result);
    };
    request.onerror = () => resolve(0);
  }))).toBeGreaterThan(0);
  hold = false;
  await page.reload();
  const landed = conversation(page).locator("[data-kind='message']:not([data-message-id^='r:'])").filter({ hasText: text });
  await expect(landed).toHaveCount(1, { timeout: 15_000 });
  await expect(landed.locator(".images img")).toBeVisible();
  await expect(conversation(page).getByText("Not delivered")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("chat.heldSends"))).toBeNull();
});

test("Reply to thread in the side pane sends to the job", async ({ page }) => {
  await open(page, `#/c/${VENT}?thread=${encodeURIComponent(VENT_JOB)}`);
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toContainText("ECONNREFUSED");
  const input = composerInput(pane);
  await input.click();
  const word = tag();
  await page.keyboard.type(`job reply ${word}`);
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${encodeURIComponent(VENT_JOB)}/send`));
  await page.keyboard.press("Enter");
  expect(((await sent).postDataJSON() as { text: string }).text).toBe(`job reply ${word}`);
  await expect(pane.locator(".row.own").filter({ hasText: word })).toBeVisible();
  await expect(row(page, "t12")).toBeVisible();
});

test("a send that waits for a working slot shows its place in the turn queue until the run starts", async ({ page, request }) => {
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `queue ${tag()}` } })).json()) as { id: string; room: string; thread: string };
  await open(page, `#/c/${agent.room}`);
  await composerInput(conversation(page)).click();
  await page.keyboard.type(`queue ${tag()}`);
  await page.keyboard.press("Enter");
  const note = conversation(page).locator(".row.own [data-note]").last();
  await expect(note).toHaveText("Waits at place 3 of 7 for a working slot.");
  await expect(page.locator(".typing")).toContainText("waits at place 3 of 7");
  await expect(conversation(page).locator(".row.own [data-note]")).toHaveCount(0, { timeout: 10_000 });
});

test("sends while the agent works show at once at full strength, and the next send never waits on the last", async ({ page, request }) => {
  test.setTimeout(60_000);
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `steer ${tag()}` } })).json()) as { id: string; room: string; thread: string };
  await open(page, `#/c/${agent.room}`);
  const input = composerInput(conversation(page));
  await input.click();
  await page.keyboard.type(`slow ${tag()}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("stop")).toBeVisible({ timeout: 8_000 });
  // pi-host takes its time; the chat server must not make the page wait for it.
  await page.route(`**/api/c/${agent.room}/send`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  const words = [tag(), tag(), tag()];
  for (const word of words) {
    await page.keyboard.type(`steer ${word}`);
    await page.keyboard.press("Enter");
    await expect(input).toHaveText("");
  }
  for (const word of words) {
    const mine = conversation(page).locator(".row.own").filter({ hasText: `steer ${word}` });
    await expect(mine).toBeVisible({ timeout: 1_000 });
    await expect(mine).toHaveCSS("opacity", "1");
  }
  await expect(conversation(page).locator('[data-send-state="sending"]')).toHaveCount(0, { timeout: 10_000 });
  await page.unroute(`**/api/c/${agent.room}/send`);
  await open(page, `#/c/${agent.room}`);
  await expect(conversation(page).locator(".row.own").filter({ hasText: `steer ${words[2]}` })).toBeVisible();
});

test("a send the chat server never gets reads Not delivered, and Retry sends it", async ({ page, request }) => {
  test.setTimeout(60_000);
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `offline ${tag()}` } })).json()) as { id: string; room: string; thread: string };
  await open(page, `#/c/${agent.room}`);
  await page.route(`**/api/c/${agent.room}/send`, (route) => route.abort("connectionrefused"));
  const word = tag();
  await composerInput(conversation(page)).click();
  await page.keyboard.type(`offline ${word}`);
  await page.keyboard.press("Enter");
  const mine = conversation(page).locator(".row.own").filter({ hasText: `offline ${word}` });
  await expect(mine).toBeVisible({ timeout: 1_000 });
  const state = mine.locator("[data-send-state]");
  await expect(state).toHaveAttribute("data-send-state", "failed", { timeout: 16_000 });
  await expect(state).toContainText("Not delivered");
  await page.unroute(`**/api/c/${agent.room}/send`);
  await state.getByRole("button", { name: "Retry" }).click();
  await expect(conversation(page).locator(".row.own").filter({ hasText: `offline ${word}` })).toHaveCount(1);
  await expect(conversation(page).locator('.row.own[data-message-id^="p"]').filter({ hasText: `offline ${word}` })).toBeVisible({ timeout: 8_000 });
  await expect(conversation(page).locator("[data-send-state]")).toHaveCount(0);
});

test("a Not delivered send outlives a reload and a closed view, and Retry sends it", async ({ page, request }) => {
  test.setTimeout(60_000);
  const agent = (await (await request.post("/api/agents", { data: { kind: "chat", name: `reload ${tag()}` } })).json()) as { id: string; room: string; thread: string };
  await open(page, `#/c/${agent.room}`);
  await page.route(`**/api/c/${agent.room}/send`, (route) => route.abort("connectionrefused"));
  const word = tag();
  await composerInput(conversation(page)).click();
  await page.keyboard.type(`kept ${word}`);
  await page.keyboard.press("Enter");
  const mine = () => conversation(page).locator(".row.own").filter({ hasText: `kept ${word}` });
  await expect(mine().locator("[data-send-state]")).toHaveAttribute("data-send-state", "failed", { timeout: 16_000 });
  await page.unroute(`**/api/c/${agent.room}/send`);
  await page.reload();
  await expect(mine().locator("[data-send-state]")).toContainText("Not delivered");
  await open(page, `#/c/${FRONTEND}`);
  await open(page, `#/c/${agent.room}`);
  await expect(mine()).toHaveCount(1);
  await mine().locator("[data-send-state]").getByRole("button", { name: "Retry" }).click();
  await expect(conversation(page).locator('.row.own[data-message-id^="p"]').filter({ hasText: `kept ${word}` })).toBeVisible({ timeout: 8_000 });
  await expect(conversation(page).locator("[data-send-state]")).toHaveCount(0);
  await page.reload();
  await expect(mine()).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("chat.heldSends"))).toBeNull();
});
