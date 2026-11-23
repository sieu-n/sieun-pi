import { expect, test, type Page } from "@playwright/test";
import { VENT, composerInput, conversation, open, row, tag } from "../channel/helpers.ts";

/** Vent's DM in the fixture (server/fixture/seed.ts): p8 holds a job pill and why "done", p9 is the owner's delivered post, p10 answers it. */
const DM = "dm_vent";
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

test("the sidebar's Direct messages hold one row per agent and no job", async ({ page, request }) => {
  const listed = (await (await request.get("/api/sidebar")).json()) as { solo: { id: string; name: string }[]; dms: { id: string; agent?: string; name: string }[] };
  const all = (await (await request.get("/api/conversations")).json()) as { id: string; kind: string; name: string; archived: boolean }[];
  await open(page, `#/c/${DM}`);
  expect(listed.dms.length).toBeGreaterThan(0);
  for (const dm of listed.dms) {
    expect(dm.id).toMatch(/^dm_/);
    expect(dm.agent).toBe(`ag_${dm.id.slice(3)}`);
    await expect(sidebar(page).locator(`a[href="#/c/${dm.id}"]`)).toBeVisible();
  }
  // An untitled root chat is no agent and no Solo room, so no sidebar group lists it: Solo holds Solo rooms (`so_`) only.
  for (const room of listed.solo) expect(room.id).toMatch(/^so_/);
  expect([...listed.solo, ...listed.dms].some((c) => c.name === "New thread")).toBe(false);
  const jobs = all.filter((c) => c.kind === "job" && !c.archived);
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) await expect(sidebar(page).locator(`a[href="#/c/${encodeURIComponent(job.id)}"]`)).toHaveCount(0);
  await expect(sidebar(page).locator(`a[href="#/c/${VENT}"]`)).toHaveCount(0);
});

test("a DM draws posts as bubbles, with a why label, Show work and a job pill that opens the job's transcript", async ({ page }) => {
  await open(page, `#/c/${DM}`);
  await expect(conversation(page)).toHaveAttribute("data-kind", "dm");
  const done = row(page, "p8");
  await expect(done.locator("[data-why]")).toHaveText("Done");
  await expect(row(page, "p10").locator("[data-why]")).toHaveText("Answer");
  await expect(row(page, "p10")).toContainText("The Mac sleeps every night");
  await expect(row(page, "p10").locator("[data-show-work]")).toHaveAttribute("href", new RegExp(`^#/c/${VENT}\\?m=e\\d+$`));
  await expect(row(page, "p9")).toContainText("Should the relay page me when the Mac sleeps?");
  await expect(row(page, "p9").locator("[data-send-state]")).toHaveCount(0);
  const pill = done.locator("[data-thread-pill]");
  await expect(pill).toContainText("Read the canary logs");
  await pill.click();
  await expect(page).toHaveURL(new RegExp(`thread=${encodeURIComponent(`${VENT}:`)}\\d+`));
  await expect(page.getByTestId("timeline").nth(1)).toContainText("ECONNREFUSED", { timeout: 10_000 });
});

test("Show work opens the work thread at the turn behind the post", async ({ page }) => {
  await open(page, `#/c/${DM}`);
  await row(page, "p10").locator("[data-show-work]").click();
  await expect(page).toHaveURL(new RegExp(`#/c/${VENT}\\?m=e\\d+$`));
  await expect(conversation(page)).toHaveAttribute("data-conversation", VENT);
  await expect(conversation(page).locator("[data-flash]")).toHaveCount(1);
});

test("an owner send shows at once, its reply post arrives, and a reload keeps both", async ({ page }) => {
  await open(page, "#/c/dm_frontend-bro");
  const text = `Is the relay up now? ${tag()}`;
  await composerInput(page).fill(text);
  await composerInput(page).press("Enter");
  const mine = conversation(page).locator(".row.own[data-message-id]").filter({ hasText: text });
  await expect(mine).toBeVisible({ timeout: 1_000 });
  await expect(mine).toHaveAttribute("data-message-id", /^p\d+$/, { timeout: 5_000 });
  const id = await mine.getAttribute("data-message-id");
  const seq = Number(id!.slice(1));
  const reply = row(page, `p${seq + 1}`);
  await expect(reply).toBeVisible({ timeout: 10_000 });
  await expect(reply).not.toHaveClass(/own/);
  const answer = (await reply.locator(".msg-text").first().innerText()).trim();
  await page.reload();
  await expect(row(page, id!)).toContainText(text, { timeout: 15_000 });
  await expect(row(page, `p${seq + 1}`)).toContainText(answer.slice(0, 30));
  await expect(row(page, id!).locator("[data-send-state]")).toHaveCount(0);
});

test("the owner reacts through the hover bar's picker, his chip is highlighted, a reload keeps it and a click takes it off", async ({ page }) => {
  // A test agent's DM and a quiet send, which gets no answer. A post that lands between the hover and the click moves the row out from under
  // the pointer, and the hover bar takes no click then: the fixture's answer comes as two posts 400 ms apart, and other specs post to the
  // seeded DMs, such as board/plan-steps.spec.ts to Crawler VP's.
  const agent = (await (await page.request.post("/api/agents", { data: { kind: "chat", name: `reaction dm ${tag()}`, test: true } })).json()) as { room: string };
  await open(page, `#/c/${agent.room}`);
  const text = `quiet reaction check ${tag()}`;
  await composerInput(page).fill(text);
  await composerInput(page).press("Enter");
  const mine = conversation(page).locator(".row.own[data-message-id]").filter({ hasText: text });
  await expect(mine).toHaveAttribute("data-message-id", /^p\d+$/, { timeout: 5_000 });
  // The Sent line under the post goes once the agent has it, which moves the rows too.
  await expect(mine.locator("[data-send-state]")).toHaveCount(0, { timeout: 10_000 });

  await mine.hover();
  await mine.locator("[data-add-reaction]").click();
  await page.locator("[data-emoji-picker] [data-emoji='👍']").first().click();
  await expect(page.locator("[data-emoji-picker]")).toHaveCount(0);
  const thumbs = mine.locator('[data-reaction="👍"]');
  await expect(thumbs).toHaveAttribute("aria-pressed", "true");
  await expect(thumbs).toHaveAccessibleName("You reacted with :+1:");
  await page.reload();
  await expect(thumbs).toContainText("1", { timeout: 15_000 });
  await thumbs.click();
  await expect(thumbs).toHaveCount(0);
});

test("Open main thread opens the agent's transcript", async ({ page }) => {
  await open(page, `#/c/${DM}`);
  await page.getByRole("link", { name: "Open main thread" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${VENT}$`));
  await expect(conversation(page)).toHaveAttribute("data-conversation", VENT);
  await expect(conversation(page).locator('[data-kind="turn"]').first()).toBeVisible({ timeout: 10_000 });
});

test("the board side panel in a DM shows the agent's board", async ({ page }) => {
  await open(page, `#/c/${DM}`);
  await page.getByTestId("board-button").click();
  const pane = page.getByTestId("board-pane");
  await expect(pane.locator("[data-chat]")).toHaveAttribute("data-chat", "ag_vent");
  await expect(pane).toContainText("Watch the relay for a week", { timeout: 10_000 });
});
