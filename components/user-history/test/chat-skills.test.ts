import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enabledBySettings, firstPrompt, SKILL_CHARS_PER_TOKEN, SKILLS_HEADER_TOKENS, skillBlock, skillsView, type SkillRoots } from "../src/chat-skills.ts";

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
    put(join(agentDir, "skills/manual/SKILL.md"), skill("manual", "description: Only a /skill command loads it.\ndisable-model-invocation: true")),
    put(join(agentDir, "skills/py-tool/SKILL.md"), skill("py-tool", "description: A python skill.")),
    put(join(agentDir, "skills/py-tool/pyproject.toml"), "[project]\nname = \"py-tool\"\n"),
    put(join(agentDir, "skills/py-tool/src/py_tool/__init__.py"), ""),
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
      "global agents-one on", "global linked on", "global manual on", "global nameless on", "global off off", "global plain on", "global py-tool on",
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
    assert.deepEqual(await skillsView({ agentDir: join(base, "a"), agentsSkills: join(base, "b"), release: null, repo: join(base, "c") }), {
      skills: [], tokens: { groups: { global: 0, "built-in": 0, repo: 0 }, header: 0, total: 0, charsPerToken: SKILL_CHARS_PER_TOKEN, firstPrompt: null } });
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

test("skillBlock renders a skill the way Prime 0.9.8 lists it in the system prompt", () => {
  assert.equal(skillBlock({ name: "edit", description: "Replace a string. Use it for <one> edit & 'more'.", location: "/r/skills/edit/SKILL.md", pythonImport: "edit" }), [
    "  <skill>", "    <name>edit</name>", "    <type>python</type>", "    <python_import>edit</python_import>",
    "    <description>Replace a string. Use it for &lt;one&gt; edit &amp; &apos;more&apos;.</description>", "    <location>/r/skills/edit/SKILL.md</location>", "  </skill>",
  ].join("\n"));
  assert.ok(!skillBlock({ name: "how", description: "d", location: "/l", pythonImport: null }).includes("python"));
});

test("skillsView counts the tokens of each skill Prime lists, and none for one it leaves out", async () => {
  const { base, roots } = await fakeTree();
  try {
    const { skills, tokens } = await skillsView(roots);
    const at = (source: string, name: string) => skills.find(item => item.source === source && item.name === name)!;
    const plain = skillBlock({ name: "plain", description: "Folded over two lines.", location: join(roots.agentDir, "skills/plain/SKILL.md"), pythonImport: null });
    assert.equal(at("global", "plain").tokens, Math.round(plain.length / SKILL_CHARS_PER_TOKEN));
    const python = skillBlock({ name: "py-tool", description: "A python skill.", location: join(roots.agentDir, "skills/py-tool/SKILL.md"), pythonImport: "py_tool" });
    assert.equal(at("global", "py-tool").tokens, Math.round(python.length / SKILL_CHARS_PER_TOKEN));
    for (const [source, name] of [["global", "off"], ["global", "manual"], ["built-in", "plain"], ["built-in", "websearch"], ["repo", "native"], ["repo", "deep"]])
      assert.equal(at(source!, name!).tokens, 0, `${source} ${name}`);
    assert.equal(at("global", "manual").userOnly, true);
    for (const source of ["global", "built-in", "repo"] as const)
      assert.equal(tokens.groups[source], skills.filter(item => item.source === source).reduce((sum, item) => sum + item.tokens, 0));
    assert.equal(tokens.header, SKILLS_HEADER_TOKENS);
    assert.equal(tokens.total, tokens.groups.global + tokens.groups["built-in"] + tokens.groups.repo + SKILLS_HEADER_TOKENS);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("firstPrompt reads the newest root session in the repo whose first reply has usage", async () => {
  const base = await mkdtemp(join(tmpdir(), "chat-skills-"));
  const session = (cwd: string, usage: Record<string, number>, parent?: string) => [
    { type: "session", id: "x", cwd, ...parent ? { parentSession: parent } : {} },
    { type: "custom_message", customType: "harness_digest", content: "digest" },
    { type: "message", message: { role: "user", content: "go" } },
    { type: "message", message: { role: "assistant", usage: { output: 9, ...usage }, timestamp: 1_000 } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
  try {
    await Promise.all([
      put(join(base, "01a0-old.jsonl"), session("/repo", { input: 4, cacheRead: 575, cacheWrite: 20_000 })),
      put(join(base, "01a1-real.jsonl"), session("/repo", { input: 4, cacheRead: 575, cacheWrite: 21_163 })),
      put(join(base, "01a2-failed.jsonl"), session("/repo", { input: 0, cacheRead: 0, cacheWrite: 0 })),
      put(join(base, "01a3-home.jsonl"), session("/home", { input: 4, cacheRead: 0, cacheWrite: 16_000 })),
      put(join(base, "01a4-child.jsonl"), session("/repo", { input: 4, cacheRead: 0, cacheWrite: 17_000 }, "/parent.jsonl")),
      put(join(base, "notes.txt"), "not a session"),
    ]);
    assert.deepEqual(await firstPrompt(base, "/repo"), { tokens: 21_742, at: 1_000, sessionId: "01a1-real" });
    assert.equal(await firstPrompt(base, "/elsewhere"), null);
    assert.equal(await firstPrompt(join(base, "missing"), "/repo"), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("skillsView reads this machine", async () => {
  const { skills, tokens } = await skillsView();
  assert.equal(tokens.total, skills.reduce((sum, item) => sum + item.tokens, 0) + tokens.header);
  const order = ["global", "built-in", "repo"];
  for (const [index, item] of skills.entries()) {
    assert.ok(item.path.endsWith("SKILL.md"));
    if (index > 0) assert.ok(order.indexOf(skills[index - 1]!.source) <= order.indexOf(item.source));
  }
});
