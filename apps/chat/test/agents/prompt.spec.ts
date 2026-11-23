import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { uniqueName } from "./helpers.ts";

/** The AgentPrompt fields the spec reads; the full type is web/src/lib/api/types.ts. */
interface Prompt {
  kinds: { kind: "work" | "comm" | "job"; conversation: number; sections: { key: string; text: string; message?: true }[] }[];
}

test("the Prompt tab shows each thread kind's whole prompt with its size, folded sections, their text and copy", async ({ page, request }) => {
  // The spec owns its agent: other specs move a shared agent's project folder mid-run, which changes its prompt between two reads.
  const created = await request.post("/api/agents", { data: { name: uniqueName("prompt"), test: true } });
  expect(created.ok()).toBeTruthy();
  const agent = (await created.json()) as { id: string };
  try {
    await checkPrompt(page, request, agent.id);
  } finally {
    await request.patch(`/api/c/${encodeURIComponent(agent.id)}`, { data: { archived: true } });
  }
});

async function checkPrompt(page: Page, request: APIRequestContext, id: string) {
  const response = await request.get(`/api/agents/${encodeURIComponent(id)}/prompt`);
  expect(response.ok()).toBeTruthy();
  const prompt = (await response.json()) as Prompt;
  expect(prompt.kinds.map((k) => k.kind)[0]).toBe("work");

  await page.goto(`/#/agents/${encodeURIComponent(id)}?section=prompt`);
  const panel = page.getByTestId("agent-config").getByRole("tabpanel");
  for (const kind of prompt.kinds) {
    const block = panel.locator(`section[data-kind="${kind.kind}"]`);
    const size = kind.sections.reduce((n, s) => n + s.text.length, 0);
    // The server builds the prompts in a child process, about 3 s alone and longer beside the other workers' fixture load.
    await expect(block.locator(".kind-head")).toContainText(`${size.toLocaleString("en-US")} characters`, { timeout: 30_000 });
    await expect(block.getByRole("button", { name: /^Copy the .* prompt$/ })).toBeVisible();
    // Each group (Prime's prompt, what pi-host adds, a root's digest) holds at most 6 sections, so every row shows with no Show all.
    await expect(block.locator("li.section")).toHaveCount(kind.sections.length);
  }

  // A section opens to its text and source, and a root's digest says it goes in before each turn.
  const work = panel.locator('section[data-kind="work"]');
  const first = prompt.kinds[0]!.sections[0]!;
  await work.locator(`li.section[data-key="${first.key}"]`).getByRole("button", { expanded: false }).click();
  await expect(work.locator(`li.section[data-key="${first.key}"] pre`)).toContainText(first.text.slice(0, 60));
  const digest = prompt.kinds[0]!.sections.find((s) => s.key === "harness");
  if (digest?.message) {
    await expect(work.locator('p[data-group="turn"]')).toHaveText("Sent as a message before each turn's input");
    await expect(work.locator('li.section[data-key="harness"]')).toBeVisible();
  }
  await expect(panel.getByText(/^Built by pi-host /)).toBeVisible();
}
