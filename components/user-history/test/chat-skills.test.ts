import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enabledBySettings, skillsView, type SkillRoots } from "../src/chat-skills.ts";

const skill = (name: string | null, description: string) => `---\n${name ? `name: ${name}\n` : ""}${description}\n---\n\n# Body\n`;

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function fakeTree(): Promise<{ base: string; roots: SkillRoots }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "chat-skills-")));
  const agentDir = join(base, "home/.prime/agent");
  const release = join(base, "release");
  const repo = join(base, "auto-sns-agent");
  await Promise.all([
    put(join(agentDir, "settings.json"), JSON.stringify({ bundledSkills: { websearch: false }, skills: [`-${agentDir}/skills/off`, "-pi/SKILL.md"] })),
    put(join(base, "store/linked/SKILL.md"), skill("linked", "description: Lives in a repo and is linked in.")),
    put(join(agentDir, "skills/plain/SKILL.md"), skill("plain", "description: >\n  Folded over\n  two lines.")),
    put(join(agentDir, "skills/off/SKILL.md"), skill("off", "description: Turned off in settings.")),
    put(join(agentDir, "skills/nameless/SKILL.md"), skill(null, 'description: "Say \\"hi\\"  twice."')),
    mkdir(join(agentDir, "skills/empty-folder"), { recursive: true }),
    put(join(base, "home/.agents/skills/agents-one/SKILL.md"), skill("agents-one", "description: From ~/.agents/skills.")),
    put(join(release, "package.json"), JSON.stringify({ version: "1.2.3" })),
    put(join(release, "skills/goal/SKILL.md"), skill("goal", "description: Built in.")),
    put(join(release, "skills/websearch/SKILL.md"), skill("websearch", "description: Off by bundledSkills.")),
    put(join(release, "skills/plain/SKILL.md"), skill("plain", "description: Hidden by the global plain.")),
    put(join(release, "skills/pi/SKILL.md"), skill("pi", "description: Off by a relative settings path.")),
    put(join(repo, ".prime/agent/settings.json"), JSON.stringify({ skills: ["-../../.agents/skills/workflows/common/deep"] })),
    put(join(repo, ".agents/skills/apps/web/SKILL.md"), skill("web", "description: A repo skill at depth 2.")),
    put(join(repo, ".agents/skills/apps/web/inner/SKILL.md"), skill("inner", "description: Inside another skill, so Prime never reads it.")),
    put(join(repo, ".agents/skills/apps/no-description/SKILL.md"), skill("no-description", "")),
    put(join(repo, ".agents/skills/workflows/common/deep/SKILL.md"), skill("deep", "description: Turned off in the repo's settings.")),
    put(join(repo, ".claude/skills-native/native/SKILL.md"), skill("native", "description: A Claude Code skill.")),
  ]);
  await symlink(join(base, "store/linked"), join(agentDir, "skills/linked"));
  await symlink(join(base, "nowhere"), join(agentDir, "skills/dangling"));
  return { base, roots: { agentDir, agentsSkills: join(base, "home/.agents/skills"), release, repo } };
}

test("skillsView lists global, built-in and repo skills the way Prime loads them", async () => {
  const { base, roots } = await fakeTree();
  try {
    const { skills } = await skillsView(roots);
    const rows = skills.map(({ source, name, enabled }) => `${source} ${name} ${enabled ? "on" : "off"}`);
    assert.deepEqual(rows, [
      "global agents-one on", "global linked on", "global nameless on", "global off off", "global plain on",
      "built-in goal on", "built-in pi off", "built-in plain off", "built-in websearch off",
      "repo deep off", "repo native on", "repo no-description off", "repo web on",
    ]);
    const byName = Object.fromEntries(skills.filter(item => item.source !== "built-in").map(item => [item.name, item]));
    assert.equal(byName.linked!.path, join(base, "store/linked/SKILL.md"));
    assert.equal(byName.plain!.description, "Folded over two lines.");
    assert.equal(byName.nameless!.description, 'Say "hi" twice.');
    assert.equal(skills.find(item => item.source === "built-in")!.from, "Prime 1.2.3");
    assert.equal(byName.web!.from, "auto-sns-agent");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a missing root gives no skills from it", async () => {
  const base = await mkdtemp(join(tmpdir(), "chat-skills-"));
  try {
    assert.deepEqual(await skillsView({ agentDir: join(base, "a"), agentsSkills: join(base, "b"), release: null, repo: join(base, "c") }), { skills: [] });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("settings overrides match a skill's file or folder, absolute or relative, and a ! glob", () => {
  const file = "/agent/skills/tool/SKILL.md";
  assert.equal(enabledBySettings(file, [], "/agent"), true);
  assert.equal(enabledBySettings(file, ["-/agent/skills/tool"], "/agent"), false);
  assert.equal(enabledBySettings(file, ["-skills/tool/SKILL.md"], "/agent"), false);
  assert.equal(enabledBySettings(file, ["-./skills/tool"], "/agent"), false);
  assert.equal(enabledBySettings(file, ["-tool"], "/agent"), true);
  assert.equal(enabledBySettings(file, ["!too*"], "/agent"), false);
  assert.equal(enabledBySettings(file, ["!too*", "+skills/tool"], "/agent"), true);
});

test("skillsView reads this machine", async () => {
  const { skills } = await skillsView();
  const order = ["global", "built-in", "repo"];
  for (const [index, item] of skills.entries()) {
    assert.ok(item.path.endsWith("SKILL.md"));
    if (index > 0) assert.ok(order.indexOf(skills[index - 1]!.source) <= order.indexOf(item.source));
  }
});
