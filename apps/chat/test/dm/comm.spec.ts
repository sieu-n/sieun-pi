import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { VENT, conversation, open, row } from "../channel/helpers.ts";

/**
 * A DM whose agent is split into a comm thread and a work thread (agent-model.md phase 4). The fixture seeds no comm thread yet, so the
 * live socket gives ag_vent one: the untitled solo chat stands in for it, being a root thread that is no agent and no job.
 */
const DM = "dm_vent";
const COMM = "0f1e0000-0000-4000-8000-000000000008";

type Split = { comm: "idle" | "working"; work: "idle" | "working" };
type Json = Record<string, unknown>;

/** Proxies /api/live and adds the comm thread to ag_vent and dm_vent; `set` moves the comm and work states and sends the events the server would. */
async function splitVent(page: Page): Promise<{ set: (next: Split) => void; send: (event: Json) => void }> {
  const state: Split = { comm: "idle", work: "idle" };
  let socket: WebSocketRoute | undefined;
  let vent: Json | undefined;
  const agent = (a: Json): Json => ({ ...a, status: state.work, comm: [{ room: DM, thread: COMM, status: state.comm }] });
  const room = (c: Json): Json => ({ ...c, commStatus: state.comm });
  const rewrite = (event: Json): Json => {
    if (event.type === "hello") {
      const agents = (event.agents as Json[]).map((a) => (a.id === "ag_vent" ? (vent = agent(a)) : a));
      return { ...event, agents, conversations: (event.conversations as Json[]).map((c) => (c.id === DM ? room(c) : c)) };
    }
    if (event.type === "agent" && (event.agent as Json).id === "ag_vent") return { ...event, agent: (vent = agent(event.agent as Json)) };
    if (event.type === "conversation" && (event.conversation as Json).id === DM) return { ...event, conversation: room(event.conversation as Json) };
    return event;
  };
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(JSON.stringify(rewrite(JSON.parse(String(message)) as Json))));
    ws.onMessage((message) => server.send(message));
  });
  const send = (event: Json) => socket!.send(JSON.stringify(event));
  return {
    send,
    set(next) {
      Object.assign(state, next);
      send({ type: "agent", agent: agent(vent!) });
      send({ type: "status", conversation: DM, status: next.comm === "working" || next.work === "working" ? "working" : "idle" });
    },
  };
}

const ownerPost = (text: string) => ({
  kind: "message", id: "p999", at: Date.now(), author: { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
  text, images: [], mentions: [], deliveries: [],
});

test("typing dots show while the comm thread answers, and the Work pill while the work thread runs", async ({ page }) => {
  const vent = await splitVent(page);
  await open(page, `#/c/${DM}`);
  const typing = page.locator(".typing");
  const pill = page.getByTestId("work-pill");
  vent.send({ type: "items", conversation: DM, items: [ownerPost("so what is status?")] });
  await expect(row(page, "p999")).toContainText("so what is status?");
  await expect(pill).toHaveCount(0);

  vent.set({ comm: "working", work: "idle" });
  await expect(typing).toContainText("Vent is answering");
  await expect(pill).toHaveCount(0);

  vent.set({ comm: "idle", work: "working" });
  await expect(pill).toBeVisible();
  await expect(typing).not.toContainText("answering");
  await expect(typing).not.toContainText("working now");

  vent.set({ comm: "working", work: "working" });
  await expect(typing).toContainText("Vent is answering");
  await expect(pill).toBeVisible();

  await pill.click();
  await expect(page).toHaveURL(new RegExp(`#/c/${VENT}$`));
  await expect(conversation(page)).toHaveAttribute("data-conversation", VENT);
});

test("Show work opens the post's comm turn in a thread that is no agent and no job", async ({ page }) => {
  await page.route(`**/api/c/${DM}/items*`, async (route) => {
    const body = (await (await route.fetch()).json()) as { items: Json[] };
    const items = body.items.map((item) => (item.id === "p10" ? { ...item, work: { conversation: COMM, around: "e3" } } : item));
    await route.fulfill({ json: { ...body, items } });
  });
  await open(page, `#/c/${DM}`);
  await row(page, "p10").locator("[data-show-work]").click();
  await expect(page).toHaveURL(new RegExp(`#/c/${COMM}\\?m=e3$`));
  await expect(conversation(page)).toHaveAttribute("data-conversation", COMM);
  await expect(conversation(page).locator("[data-flash]")).toHaveCount(1);
});

test("the agent's Overview lists its DM comm thread, which opens its transcript", async ({ page }) => {
  const vent = await splitVent(page);
  await open(page, "#/agents/ag_vent", "agent-config");
  const threads = page.getByTestId("agent-config").locator('[data-fact="threads"]');
  await expect(threads.getByRole("link", { name: "Work thread" })).toHaveAttribute("href", `#/c/${VENT}`);
  const comm = threads.locator(`[data-comm-thread="${COMM}"]`);
  await expect(comm).toHaveAttribute("data-room", DM);
  await expect(comm.getByRole("link", { name: "DM comm thread" })).toHaveAttribute("href", `#/c/${COMM}`);
  vent.set({ comm: "working", work: "idle" });
  await expect(comm.getByRole("img", { name: "Working" })).toBeVisible();
  await expect(page.locator(`[role="gridcell"][data-agent-id="${COMM}"]`)).toHaveCount(0);
  await comm.getByRole("link", { name: "DM comm thread" }).click();
  await expect(conversation(page)).toHaveAttribute("data-conversation", COMM);
});
