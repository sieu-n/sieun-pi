import { expect, test, type Page } from "@playwright/test";
import { card, listAgents, openAgents, uniqueName } from "./helpers.ts";

// Chrome drops in-flight dev-server loads with ERR_NETWORK_CHANGED when the box's interfaces change, so one rerun covers that.
test.describe.configure({ retries: 1 });

interface Projects { projects: { path: string; name: string }[]; default: string | null; home: string }

const panel = (page: Page) => page.getByTestId("agent-config");
const project = (page: Page) => panel(page).locator('[data-fact="cwd"]');

test("a new agent runs in the project picked in the dialog, and its panel moves it to another one", async ({ page, request }) => {
  const list = (await (await request.get("/api/projects")).json()) as Projects;
  test.skip(list.projects.length < 2, "needs two project folders on this server");
  const [first, second] = list.projects as [Projects["projects"][0], Projects["projects"][0]];

  await openAgents(page);
  await page.getByRole("button", { name: "New agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  const picker = dialog.getByRole("combobox", { name: "Project folder" });
  await expect(picker).toHaveValue(list.default!);
  await picker.selectOption(second.path);
  const name = uniqueName("spec project");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/c\/dm_[^/?]+$/);
  const id = `ag_${decodeURIComponent(page.url().split("#/c/")[1]!).slice(3)}`;

  try {
    await openAgents(page);
    await card(page, { id }).click({ position: { x: 40, y: 120 } });
    await expect(project(page)).toHaveAttribute("data-project", "yes");
    await expect(project(page).locator("code")).toHaveAttribute("title", second.path);
    await expect(project(page).getByText("No project", { exact: true })).toHaveCount(0);

    await project(page).getByRole("button", { name: "Change project folder" }).click();
    await project(page).getByRole("combobox", { name: "Project folder" }).selectOption(first.path);
    await project(page).getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Its next turn runs in the new folder")).toBeVisible();
    await expect(project(page).locator("code")).toHaveAttribute("title", first.path);
    const config = (await (await request.get(`/api/agents/${encodeURIComponent(id)}/config`)).json()) as { runs: { cwd: string; project: boolean } };
    expect(config.runs).toMatchObject({ cwd: first.path, project: true });

    await project(page).getByRole("button", { name: "Change project folder" }).click();
    await project(page).getByRole("combobox", { name: "Project folder" }).selectOption({ label: "Other folder…" });
    await project(page).getByRole("textbox", { name: "Project folder path" }).fill(list.home);
    await project(page).getByRole("button", { name: "Move" }).click();
    await expect(project(page).getByRole("alert")).toContainText("home folder");
    await expect(project(page).locator("code")).toHaveAttribute("title", first.path);
  } finally {
    await request.patch(`/api/c/${encodeURIComponent(id)}`, { data: { archived: true } });
  }
});

test("an agent in the home folder is flagged as no project in its Overview", async ({ page, request }) => {
  const home = ((await (await request.get("/api/projects")).json()) as Projects).home;
  let found: string | null = null;
  for (const agent of (await listAgents(request)).filter((a) => a.kind === "chat")) {
    const config = (await (await request.get(`/api/agents/${encodeURIComponent(agent.id)}/config`)).json()) as { runs: { cwd: string } };
    if (config.runs.cwd === home) found = agent.id;
  }
  test.skip(!found, "no agent in the home folder on this server");
  await openAgents(page);
  await card(page, { id: found! }).click({ position: { x: 40, y: 120 } });
  await expect(project(page)).toHaveAttribute("data-project", "no");
  await expect(project(page).getByText("No project", { exact: true })).toBeVisible();
  await expect(project(page)).toContainText("reads no project's AGENTS.md");
  await expect(project(page).getByRole("button", { name: "Change project folder" })).toBeVisible();
});
