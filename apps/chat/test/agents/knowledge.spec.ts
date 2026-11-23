import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The Knowledge tab of an agent's page: its memory, the skills its prompt lists, the instruction files it loads and its scripts. A script
 * kept in its folder and one its brief names both show, each with where it comes from and its path.
 */
test("the Knowledge tab lists the agent's skills, instruction files and the scripts in its folder and brief", async ({ page, request }) => {
  test.setTimeout(90_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const outside = mkdtempSync(join(tmpdir(), "knowledge-spec-"));
  try {
    const named = join(outside, "measure.py");
    writeFileSync(named, "print('measure')\n");
    const brief = `Measure with ${named} each morning, and never with ${join(outside, "missing.py")}.`;
    const agent = (await (await request.post("/api/agents", { data: { name: `knowledge ${tag}`, brief, test: true } })).json()) as { id: string; name: string };
    const config = (await (await request.get(`/api/agents/${agent.id}/config`)).json()) as { folder: { dir: string }; instructions: { files: { path: string }[] } };
    const kept = join(config.folder.dir, "tools", "sweep.mjs");
    mkdirSync(join(config.folder.dir, "tools"), { recursive: true });
    writeFileSync(kept, "console.log('sweep');\n");

    await page.goto(`/#/agents/${agent.id}?section=knowledge`);
    const panel = page.getByTestId("agent-config");
    await expect(panel.getByTestId("agent-memory")).toBeVisible();

    const scripts = panel.getByTestId("knowledge-scripts");
    await expect(scripts.getByRole("heading")).toHaveText("Scripts · 2");
    await expect(scripts.locator(`li[data-path="${kept}"]`)).toContainText("sweep.mjs");
    await expect(scripts.locator(`li[data-path="${kept}"]`)).toContainText("Kept in its folder");
    await expect(scripts.locator(`li[data-path="${named}"]`)).toContainText("Named in its brief");
    await expect(scripts).not.toContainText("missing.py");

    const files = panel.getByTestId("knowledge-files");
    for (const file of config.instructions.files) await expect(files.locator(`li[data-path="${file.path}"]`)).toBeVisible();

    const prompt = (await (await request.get(`/api/agents/${agent.id}/prompt`)).json()) as { skills: { path: string }[]; away?: string };
    const skills = panel.getByTestId("knowledge-skills");
    if (prompt.away) await expect(skills).toContainText(prompt.away);
    else {
      await expect(skills.getByRole("heading")).toHaveText(prompt.skills.length ? `Skills · ${prompt.skills.length}` : "Skills", { timeout: 30_000 });
      await expect(skills.locator("li[data-path]")).toHaveCount(Math.min(10, prompt.skills.length));
      if (prompt.skills.length > 10) {
        await skills.getByRole("button", { name: `Show all ${prompt.skills.length} skills` }).click();
        await expect(skills.locator("li[data-path]")).toHaveCount(prompt.skills.length);
      }
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
