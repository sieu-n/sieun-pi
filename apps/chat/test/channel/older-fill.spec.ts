import { expect, test, type Route } from "@playwright/test";
import { open, tag } from "./helpers";

/**
 * A short page that opens at its bottom reads the page above it on its own. Nobody waits on that read, since the open's rows already show,
 * so it goes out as a read ahead and the d2 speed duty counts it nowhere. On 11-23 one such read of 564 ms counted as a wait on a job
 * page's open (~/work/p215-opens/summary.md). A read of the rows above that he scrolled for stays his wait.
 */
const FILL_MS = 700;
/** The spec's own reads of older rows answer 203, so their timing lines stand apart from the open's read, which a loaded box can slow past FILL_MS. */
const OLDER = 203;

type Sample = { p: string; s: number; ms: number; bg?: string };

test("the read of older rows a short page fills itself with is a read ahead, and one he scrolled for is his wait", async ({ page }) => {
  // A test room of its own, so no other spec's post or agent's answer moves the feed and starts a read of older rows nobody scrolled for.
  const name = `older-fill-${tag()}`;
  const room = ((await (await page.request.post("/api/rooms", { data: { kind: "channel", name, members: [], test: true } })).json()) as { id: string }).id;
  for (let n = 1; n <= 3; n++) await page.request.post(`/api/c/${room}/send`, { data: { text: `post ${n} of ${name}`, requestId: crypto.randomUUID() } });

  const olderReads: string[] = [];
  let answered = 0;
  await page.route(new RegExp(`/api/c/${room}/items(\\?.*)?$`), async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before")) {
      olderReads.push(url.search);
      await new Promise((resolve) => setTimeout(resolve, FILL_MS));
      await route.fulfill({ status: OLDER, json: { items: [], older: "e0" } });
      answered += 1;
      return;
    }
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...((await answer.json()) as object), older: "e1" } });
  });
  // Every batch of timing lines, the one the 10 s timer posts while the spec runs on a loaded box as well as the last one on pagehide.
  const samples: Sample[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/timings")) samples.push(...(r.postDataJSON() as { samples: Sample[] }).samples);
  });

  await open(page, `#/c/${room}`);
  // A scroll event with no hand of his on the feed, as the open's own move to the bottom makes on a page under 240 px from its top. It goes
  // again until the read leaves, since the feed reads older rows only once its first page shows; the read in flight stops a second one.
  const feed = page.getByTestId("timeline").first();
  await expect.poll(async () => {
    if (!olderReads.length) await feed.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    return olderReads.length;
  }, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => answered, { timeout: 10_000 }).toBe(1);

  // His wheel on the feed and the scroll it makes, in one go, as a real wheel scrolls within the second the feed counts as his (HAND_MS).
  // It goes again until the read leaves, since the fill's answer may still be landing.
  await feed.hover();
  await expect.poll(async () => {
    if (olderReads.length < 2) {
      await feed.evaluate((el) => el.addEventListener("wheel", () => el.dispatchEvent(new Event("scroll")), { once: true }));
      await page.mouse.wheel(0, -100);
    }
    return olderReads.length;
  }, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => answered, { timeout: 10_000 }).toBe(2);

  const older = () => samples.filter((s) => s.p === `/api/c/${room}/items` && s.s === OLDER);
  await expect.poll(async () => {
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    return older().length;
  }, { timeout: 10_000 }).toBe(2);
  expect(older().map((s) => [s.bg ?? "his wait", s.ms >= FILL_MS])).toEqual([["ahead", true], ["his wait", true]]);
  await page.request.patch(`/api/rooms/${room}`, { data: { archived: true } });
});
