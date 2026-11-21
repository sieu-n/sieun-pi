import { expect, test, type Page } from "@playwright/test";
import { open, tag } from "../channel/helpers";

/**
 * New messages notify as Slack's desktop app does (lib/notices.svelte.ts): a system notification for a DM, mention or reply while the owner
 * is not looking at it, the unread count in the window title and on the Dock icon, and the open place in the title.
 */

type Shown = { title: string; body: string };

/** Stubs the Web Notification API as granted and records each notification; `focused` sets what document.hasFocus answers. */
async function stubBrowser(page: Page, focused: boolean): Promise<void> {
  await page.addInitScript((hasFocus) => {
    // Kept in sessionStorage, so a reload by the open() helper keeps what showed before it.
    const shown: { title: string; body: string }[] = JSON.parse(sessionStorage.getItem("__shown") ?? "[]");
    class Stub {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body?: string } = {}) {
        shown.push({ title, body: opts.body ?? "" });
        sessionStorage.setItem("__shown", JSON.stringify(shown));
      }
      close() {}
    }
    Object.assign(window, { Notification: Stub });
    document.hasFocus = () => hasFocus;
  }, focused);
}

const shown = (page: Page): Promise<Shown[]> => page.evaluate(() => JSON.parse(sessionStorage.getItem("__shown") ?? "[]")).catch(() => []);

/** A throwaway agent and its DM; the fixture agent answers each post. */
async function testAgent(page: Page): Promise<{ id: string; name: string; room: string }> {
  const name = `notify ${tag()}`;
  const res = await page.request.post("/api/agents", { data: { kind: "chat", name, test: true } });
  expect(res.ok()).toBe(true);
  return { ...((await res.json()) as { id: string; room: string }), name };
}

/** Puts the window in the background after load, since a dev build reads as stale and reloads on load in an unfocused window (reload.ts). */
const unfocus = (page: Page) => page.evaluate(() => (document.hasFocus = () => false));

test("an agent's DM reply raises a system notification while the window is in the background", async ({ page }) => {
  await stubBrowser(page, true);
  const agent = await testAgent(page);
  await open(page, `#/c/${agent.room}`);
  await unfocus(page);
  await page.request.post(`/api/c/${agent.room}/send`, { data: { text: "ping for a notice", requestId: crypto.randomUUID() } });
  await expect.poll(() => shown(page), { timeout: 15_000 }).toContainEqual(expect.objectContaining({ title: agent.name }) as unknown as Shown);
  const note = (await shown(page)).find((n) => n.title === agent.name)!;
  expect(note.body.length).toBeGreaterThan(0);
});

test("the open DM in a focused window raises no notification, and Off in the setting stops them", async ({ page }) => {
  await stubBrowser(page, true);
  const agent = await testAgent(page);
  await open(page, `#/c/${agent.room}`);
  await page.request.post(`/api/c/${agent.room}/send`, { data: { text: "in view", requestId: crypto.randomUUID() } });
  await expect(page.getByTestId("timeline").getByText("in view")).toBeVisible();
  await page.waitForTimeout(3000);
  expect(await shown(page)).toEqual([]);

  await page.evaluate(() => localStorage.setItem("chat.notify", JSON.stringify({ level: "off", badge: true })));
  await page.reload();
  await page.getByTestId("timeline").first().waitFor();
  await unfocus(page);
  await page.request.post(`/api/c/${agent.room}/send`, { data: { text: "while off", requestId: crypto.randomUUID() } });
  await page.waitForTimeout(3000);
  expect(await shown(page)).toEqual([]);
});

test("the title names the open place with the unread count, and the Mac app gets the same title and the Dock badge", async ({ page }) => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  await page.exposeFunction("__invoke", (cmd: string, args?: Record<string, unknown>) => void calls.push({ cmd, ...(args ? { args } : {}) }));
  await page.addInitScript(() => {
    const record = (window as unknown as { __invoke: (cmd: string, args?: unknown) => void }).__invoke;
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args?: unknown) => {
          record(cmd, args);
          return cmd === "plugin:notification|is_permission_granted" ? true : null;
        },
      },
    });
  });
  await open(page, "#/c/ch_general");
  const sidebar = (await (await page.request.get("/api/sidebar")).json()) as Record<"solo" | "channels" | "dms", { unread: number; archived: boolean }[]>;
  const unread = [...sidebar.solo, ...sidebar.channels, ...sidebar.dms].filter((r) => !r.archived).reduce((sum, r) => sum + r.unread, 0);
  const title = `${unread ? `(${unread}) ` : ""}#general - sw factory`;
  await expect(page).toHaveTitle(title);
  await expect.poll(() => calls.find((c) => c.cmd === "plugin:window|set_title" && c.args?.value === title)).toBeTruthy();
  await expect.poll(() => calls.findLast((c) => c.cmd === "plugin:window|set_badge_count")?.args?.value).toBe(unread || null);

  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page).toHaveTitle(`${unread ? `(${unread}) ` : ""}Agents - sw factory`);
});
