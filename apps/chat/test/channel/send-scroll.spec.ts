import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { composerInput, open, tag } from "./helpers";

/**
 * His own send takes the feed down to his post wherever he had scrolled, as in Slack, and only his own scroll unpins it (Timeline.svelte
 * `ownSend`, `handAt`). Each test makes its own room on the fixture server; "quiet" posts get no answer from a fixture member.
 */
test.describe.configure({ timeout: 90_000 });

const CODE = "```ts\n" + Array.from({ length: 12 }, (_, i) => `const line${i} = compute(${i});`).join("\n") + "\n```";
const textOf = (n: number, name: string, word: string) => (n % 4 === 0 ? `${word} post ${n} of ${name}\n\n${CODE}` : `${word} post ${n} of ${name}`);

/** Sends `count` posts that start with `word` at once into `room` (or under `threadRoot`); the server orders them by seq. */
async function fill(page: Page, room: string, name: string, count: number, threadRoot?: string, word = "quiet"): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, n) =>
    page.request.post(`/api/c/${room}/send`, { data: { text: textOf(n, name, word), requestId: crypto.randomUUID(), ...(threadRoot ? { threadRoot } : {}) } })));
}

/** A plain grey PNG of `width` by `height` px. */
function png(width: number, height: number): Buffer {
  const crc = (bytes: Buffer) => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 160)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => line)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A test channel with 40 posts, and `members` added after them. A fixture member takes its inputs one turn at a time, about 0.8 s for a
 * quiet post, so 40 posts it heard held its next answer 31 s (pi-host steers an owner post into a busy turn instead). The posts it did not
 * hear go with its next input as channel context, and a "quiet" there would hush that input too, so they say "earlier" instead.
 */
async function channel(page: Page, members: string[] = []): Promise<{ room: string; name: string }> {
  const name = `send-scroll-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } })).json()) as { id: string }).id;
  await fill(page, room, name, 40, undefined, members.length ? "earlier" : "quiet");
  if (members.length) expect((await page.request.post(`/api/rooms/${room}/members`, { data: { agents: members } })).ok()).toBe(true);
  return { room, name };
}

const mainFeed = (page: Page) => page.locator("section.conversation [data-testid=timeline]").first();
const gap = (feed: Locator) => feed.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Wheels the feed up by `px` as his hand would, then waits for the scroll to settle. */
async function wheelUp(page: Page, feed: Locator, px: number): Promise<void> {
  const box = (await feed.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let moved = 0; moved < px; moved += 250) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(600);
  expect(await gap(feed)).toBeGreaterThan(px / 2);
}

/** His post's bottom edge sits inside the feed, and the feed is at its bottom. */
async function expectShown(feed: Locator, text: string): Promise<void> {
  const post = feed.locator("li[data-message-id]").filter({ hasText: text }).last();
  await expect.poll(async () => {
    const [box, at, left] = await Promise.all([feed.boundingBox(), post.boundingBox(), gap(feed)]);
    return !!box && !!at && at.y + at.height <= box.y + box.height + 2 && left < 4;
  }, { timeout: 5_000 }).toBe(true);
}

async function send(page: Page, scope: Page | Locator, text: string): Promise<void> {
  await composerInput(scope).fill(text);
  await composerInput(scope).press("Enter");
}

test("a 5-line send from the bottom of a channel ends with his whole post in view", async ({ page }) => {
  const { room } = await channel(page);
  await open(page, `#/c/${room}`);
  const feed = mainFeed(page);
  await expect.poll(() => gap(feed)).toBeLessThan(4);
  const text = `quiet five lines ${tag()}`;
  await composerInput(page).fill(text);
  for (let line = 2; line <= 5; line++) {
    await composerInput(page).press("Shift+Enter");
    await composerInput(page).pressSequentially(`line ${line} of the post`);
  }
  await composerInput(page).press("Enter");
  await expectShown(feed, text);
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});

test("a send after he scrolled the channel up goes down to his post", async ({ page }) => {
  const { room } = await channel(page);
  await open(page, `#/c/${room}`);
  const feed = mainFeed(page);
  await expect.poll(() => gap(feed)).toBeLessThan(4);
  await wheelUp(page, feed, 1500);
  const text = `quiet sent from above ${tag()}`;
  await send(page, page, text);
  await expectShown(feed, text);
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});

test("a reply sent after he scrolled the thread pane up goes down to it", async ({ page }) => {
  const name = `send-scroll-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } })).json()) as { id: string }).id;
  const root = ((await (await page.request.post(`/api/c/${room}/send`, { data: { text: "quiet thread root", requestId: crypto.randomUUID() } })).json()) as { item: { id: string } }).item.id;
  await fill(page, room, name, 40, root);
  await open(page, `#/c/${room}?thread=${root}`);
  const pane = page.getByTestId("thread-pane");
  const feed = pane.getByTestId("timeline");
  await expect(feed.locator("li[data-message-id]").filter({ hasText: "quiet post 39" })).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => gap(feed)).toBeLessThan(4);
  await wheelUp(page, feed, 1500);
  const text = `quiet reply from above ${tag()}`;
  await send(page, pane, text);
  await expectShown(feed, text);
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});

test("a DM send with the New line held above goes down to his post", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { kind: "chat", name: `send scroll ${tag()}`, test: true } })).json()) as { room: string };
  await fill(page, agent.room, "the dm", 40);
  const items = (await (await page.request.get(`/api/c/${agent.room}/items`)).json()) as { items: { id: string; kind: string }[] };
  const posts = items.items.filter((item) => item.kind === "message");
  await page.request.post(`/api/c/${agent.room}/read`, { data: { unreadFrom: posts[posts.length - 30]!.id } });
  await open(page, `#/c/${agent.room}`);
  const feed = mainFeed(page);
  await expect(page.getByTestId("new-line")).toBeInViewport();
  await page.waitForTimeout(500);
  expect(await gap(feed)).toBeGreaterThan(400);
  const text = `quiet sent past the new line ${tag()}`;
  await send(page, page, text);
  await expectShown(feed, text);
});

test("an image that loads late while the feed sits at its bottom keeps the feed there", async ({ page }) => {
  const { room } = await channel(page);
  const upload = (await (await page.request.post("/api/uploads", { data: png(300, 600), headers: { "content-type": "image/png" } })).json()) as { url: string };
  // A markdown image carries no size, so it draws at no height and grows when its bytes come, here 1.5 s late, at 600 px tall.
  const late = `${upload.url}?late=${tag()}`;
  await page.route((url) => url.href.includes(late), async (route) => {
    await new Promise((done) => setTimeout(done, 1_500));
    await route.continue();
  });
  await open(page, `#/c/${room}`);
  const feed = mainFeed(page);
  await expect.poll(() => gap(feed)).toBeLessThan(4);
  const text = `quiet late image ${tag()}`;
  await page.request.post(`/api/c/${room}/send`, { data: { text: `${text}\n\n![late](${late})`, requestId: crypto.randomUUID() } });
  await page.waitForTimeout(2_500);
  await expectShown(feed, text);
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});

test("a post from elsewhere and an agent's answer to it leave the feed where he reads above", async ({ page }) => {
  const { room } = await channel(page, ["ag_frontend-bro"]);
  await open(page, `#/c/${room}`);
  const feed = mainFeed(page);
  await expect.poll(() => gap(feed)).toBeLessThan(4);
  await wheelUp(page, feed, 1500);
  const top = await feed.evaluate((el) => el.scrollTop);
  // A post without "quiet" wakes the fixture member, whose answer lands in that post's thread while he reads above, a second or two later.
  const asked = `please answer ${tag()}`;
  await page.request.post(`/api/c/${room}/send`, { data: { text: asked, requestId: crypto.randomUUID() } });
  const post = feed.locator("li[data-message-id]").filter({ hasText: asked });
  await expect(post).toHaveCount(1);
  await expect(post).toContainText(/\d+ repl/, { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  expect(Math.abs((await feed.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(2);
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});
