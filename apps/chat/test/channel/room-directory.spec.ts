import { expect, test } from "@playwright/test";
import { open } from "./helpers";

/**
 * The room directory's GET /api/rooms and the socket's hello. On 11-21 the owner's rooms refreshes waited p90 1151 ms (d2 run of 11-22
 * 06:30 KST): each answer differed from the kept one only in `lastSeq` and the members' run status, which no list shows, so each counted
 * as a wait, and the hello of every page load read the rooms, the board and its duties a second time. These drive the page's own modules.
 */
declare global {
  interface Window { directoryCheck: () => Promise<{ kept: boolean; lastSeq: boolean; status: boolean }> }
}

test("a rooms refresh that changes only lastSeq and member status keeps the shown list", async ({ page }) => {
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  await page.route(/\/api\/rooms$/, async (route) => {
    const response = await route.fetch();
    const rooms = (await response.json()) as { lastSeq: number; members: { status?: string }[] }[];
    for (const room of rooms) {
      room.lastSeq += 100;
      for (const member of room.members) member.status = "working";
    }
    await route.fulfill({ response, json: rooms });
  });
  const result = await page.evaluate(async () => {
    const { kept } = await import(/* @vite-ignore */ "/src/lib/api/kept.svelte.ts");
    const { reads } = await import(/* @vite-ignore */ "/src/lib/api/client.ts");
    const entry = kept(reads.rooms());
    if (entry.value === null) await entry.read();
    const before = entry.value;
    await entry.read();
    const rooms = entry.value as Record<string, unknown>[];
    return {
      kept: entry.value === before && rooms.length > 0,
      lastSeq: rooms.some((room) => "lastSeq" in room),
      status: rooms.some((room) => (room.members as Record<string, unknown>[]).some((member) => "status" in member)),
    };
  });
  expect(result).toEqual({ kept: true, lastSeq: false, status: false });
});

test("the socket's hello reads no kept answer whose read left after the socket opened", async ({ page }) => {
  await open(page, "#/c/ch_general");
  await page.waitForLoadState("networkidle");
  const sent: string[] = [];
  page.on("request", (r) => (r.url().includes("hello=1") ? sent.push(r.url()) : undefined));
  await page.evaluate(async () => {
    const { live } = await import(/* @vite-ignore */ "/src/lib/api/live.svelte.ts");
    const { kept } = await import(/* @vite-ignore */ "/src/lib/api/kept.svelte.ts");
    for (let tries = 0; !live.connected && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    const entry = kept({ path: "/api/rooms?hello=1" });
    entry.open();
    await entry.read();
  });
  await expect.poll(() => sent.length).toBe(1);
  await page.evaluate(async () => {
    const { kept } = await import(/* @vite-ignore */ "/src/lib/api/kept.svelte.ts");
    kept({ path: "/api/rooms?hello=1" }).missed();
  });
  await page.waitForTimeout(500);
  expect(sent).toHaveLength(1);
  await page.evaluate(async () => {
    const { live } = await import(/* @vite-ignore */ "/src/lib/api/live.svelte.ts");
    const { kept } = await import(/* @vite-ignore */ "/src/lib/api/kept.svelte.ts");
    live.openedAt = performance.now();
    kept({ path: "/api/rooms?hello=1" }).missed();
  });
  await expect.poll(() => sent.length).toBe(2);
});
