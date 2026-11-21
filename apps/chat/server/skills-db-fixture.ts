/**
 * A throwaway skills tree for the skills DB (server/skills-db.ts): a home folder under one root with a git source of three skills, an old
 * clone of it, Prime links, a Claude Code copy, a near copy, a broken link and a plugin skill, plus `<review dir>/sets/<name>.json` naming
 * the root, so every disk step the DB takes stays inside it. The fixture server, the tests and `sw skills` walks scan it with the real
 * scanner (scripts/skills-inventory.py with HOME set to the tree's home), so ingest, apply and undo run on real files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SkillsDbFixture = { root: string; home: string; inventory: string; setName: string; setFile: string };

const skill = (name: string, lines: string[]): string => `---\nname: ${name}\ndescription: ${lines[0]}\n---\n\n# ${name}\n\n${lines.join("\n")}\n`;

const DEPLOY = [
  "Use when you ship the fixture app.", "", "1. Run the checks.", "2. Push to main.", "3. Watch the deploy log for 5 minutes.", "4. Post the sha in the room.",
  "5. Close the ticket.", "6. Tell the owner.", "7. Check the error rate.", "8. Check the latency graph.", "9. Read the new logs.", "10. Note the time.",
];
const DEPLOY_OLD = ["Use when you ship the fixture app.", "", "1. Run the checks.", "2. Ask for a review.", "3. Push to main.", "4. Post the sha in the room."];
const NEAR = [...DEPLOY.slice(0, 11), "10. Note the time and the run id."];

function git(cwd: string, args: string[], date?: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  execFileSync("git", ["-C", cwd, ...args], { env, stdio: "ignore" });
}

export function writeSkillsDbFixture(dir: string, opts: { reviewDir: string; name?: string; box?: string }): SkillsDbFixture {
  const root = resolve(dir);
  const name = opts.name ?? "skills-db";
  if (existsSync(root) && readdirSync(root).length) throw new Error(`${root} is not empty; a skills DB fixture goes in a new or empty folder.`);
  const home = join(root, "home");
  const file = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const link = (path: string, target: string) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  };
  const source = join(home, "src/tools");
  file(join(source, ".agents/skills/deploy-notes/SKILL.md"), skill("deploy-notes", DEPLOY));
  file(join(source, ".agents/skills/board-rules/SKILL.md"), skill("board-rules", ["Use when you write the board.", "", "1. One step per line.", "2. Name the owner."]));
  file(join(source, ".agents/skills/big-guide/SKILL.md"), skill("big-guide", ["Use when you need every detail of the fixture app.", "", ...Array.from({ length: 400 }, (_, i) => `${i + 1}. A long line of guidance that repeats what the other skills say, number ${i + 1}.`)]));
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["remote", "add", "origin", "https://example.com/fixture/tools.git"]);
  git(source, ["add", "-A"]);
  git(source, ["commit", "-q", "-m", "fixture skills"]);
  const old = join(home, "code/tools-old");
  file(join(old, ".agents/skills/deploy-notes/SKILL.md"), skill("deploy-notes", DEPLOY_OLD));
  git(old, ["init", "-q", "-b", "main"]);
  git(old, ["remote", "add", "origin", "https://example.com/fixture/tools.git"]);
  git(old, ["add", "-A"]);
  git(old, ["commit", "-q", "-m", "an old clone"], new Date(Date.now() - 60 * 86_400_000).toISOString());
  for (const skillName of ["deploy-notes", "board-rules", "big-guide"]) link(join(home, ".prime/agent/skills", skillName), join(source, ".agents/skills", skillName));
  file(join(home, ".claude/skills/deploy-notes-copy/SKILL.md"), skill("deploy-notes", DEPLOY));
  file(join(home, ".claude/skills/notes-helper/SKILL.md"), skill("notes-helper", NEAR));
  link(join(home, ".claude/skills/gone"), join(source, ".agents/skills/removed-long-ago"));
  file(join(home, ".claude/plugins/cache/fixture-market/chart-kit/1.0.0/skills/bar-chart/SKILL.md"), skill("bar-chart", ["Draw a bar chart with chart-kit."]));
  mkdirSync(join(home, ".codex/skills"), { recursive: true });
  const inventory = join(root, "inventory.json");
  const stateDir = join(root, "review-state");
  const harnessStore = join(root, "harness");
  mkdirSync(harnessStore, { recursive: true });
  const setFile = join(opts.reviewDir, "sets", `${name}.json`);
  file(setFile, JSON.stringify({ inventory, stateDir, root, harnessStore, box: opts.box ?? "us-metal02", macHost: null }, null, 2) + "\n");
  return { root, home, inventory, setName: name, setFile };
}

/** The scanner run that reads the fixture tree as if its home were the box's: no Mac, no use counts. */
export function fixtureScanner(fixture: Pick<SkillsDbFixture, "home" | "inventory">, repo: string): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  return { command: "python3", args: ["scripts/skills-inventory.py", "--no-mac", "--no-usage", "--out", fixture.inventory], cwd: repo, env: { HOME: fixture.home } };
}
