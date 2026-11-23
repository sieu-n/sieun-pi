import { expect, test } from "@playwright/test";
import { listAgents } from "./helpers.ts";

/** The AgentPrompt fields the spec reads; the full type is web/src/lib/api/types.ts. */
interface Prompt {
  kinds: { kind: "work" | "comm" | "job"; conversation: number; sections: { key: string; text: string; message?: true }[] }[];
}

test("the Prompt tab shows each thread kind's whole prompt with its size, folded sections, their text and copy", async ({ page, request }) => {
  const agent = (await listAgents(request)).find((a) => a.id.startsWith("ag_"));
  test.skip(!agent, "no registered agent on this server");
  const response = await request.get(`/api/agents/${encodeURIComponent(agent!.id)}/prompt`);
  expect(response.ok()).toBeTruthy();
  const prompt = (await response.json()) as Prompt;
  expect(prompt.kinds.map((k) => k.kind)[0]).toBe("work");

  await page.goto(`/#/agents/${encodeURIComponent(agent!.id)}?section=prompt`);
  const panel = page.getByTestId("agent-config").getByRole("tabpanel");
  for (const kind of prompt.kinds) {
    const block = panel.locator(`section[data-kind="${kind.kind}"]`);
    const size = kind.sections.reduce((n, s) => n + s.text.length, 0);
    // The server builds the prompts in a child process, about 3 s alone and longer beside the other workers' fixture load.
    await expect(block.locator(".kind-head")).toContainText(`${size.toLocaleString("en-US")} characters`, { timeout: 30_000 });
    await expect(block.getByRole("button", { name: /^Copy the .* prompt$/ })).toBeVisible();
    const system = kind.sections.filter((s) => !s.message).length;
    await expect(block.locator("li.section")).toHaveCount(Math.min(system, 10) + kind.sections.length - system);
  }

  // A section opens to its text and source, and a root's digest says it goes in before each turn.
  const work = panel.locator('section[data-kind="work"]');
  const first = prompt.kinds[0]!.sections[0]!;
  await work.locator(`li.section[data-key="${first.key}"]`).getByRole("button", { expanded: false }).click();
  await expect(work.locator(`li.section[data-key="${first.key}"] pre`)).toContainText(first.text.slice(0, 60));
  const digest = prompt.kinds[0]!.sections.find((s) => s.key === "harness");
  if (digest?.message) {
    await expect(work.locator("p.turn")).toHaveText("Sent as a message before each turn's input");
    await expect(work.locator('li.section[data-key="harness"]')).toBeVisible();
  }
  await expect(panel.getByText(/^Built by pi-host /)).toBeVisible();
});
