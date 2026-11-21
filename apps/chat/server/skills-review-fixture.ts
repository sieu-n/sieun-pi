/**
 * A throwaway skills review set (server/skills-review.ts) for tests, the fixture server and a walk on live :5184: skill folders under one
 * root, an inventory.json in the shape scripts/skills-inventory.py writes, a harness store and a `git init` repo with no remote, all inside
 * that root, and `<review dir>/sets/<name>.json` naming them. Nothing in it points outside the root, so approving any of its items touches
 * only throwaway files. scripts/skills-review-fixture.mjs runs it from the shell.
 *
 * Its six items:
 * 1. `deploy-notes` has a keeper and two copies to delete, one the same and one that differs, so its diff is not empty.
 * 2. `release-steps` folds into deploy-notes and has no keeper, so the page shows its text.
 * 3. `chart-kit` is a Claude Code plugin with three skills.
 * 4. `screen-notes` lives only on the Mac, so approving it queues a Mac step.
 * 5. `old-helper` sits in the git repo, with a Mac copy at the same repo path that follows its commit.
 * 6. `board-rules` has a harness memory note to delete beside the skill it repeats.
 *
 * It uses only node: modules, so the .mjs script can import this file on plain node.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type FixtureSet = { name: string; root: string; inventory: string; stateDir: string; harnessStore: string; setFile: string };

type Row = Record<string, unknown>;

const skill = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${body.split("\n")[0]}\n---\n\n# ${name}\n\n${body}\n`;

const DEPLOY = skill("deploy-notes", "Use when you ship the fixture app.\n\n1. Run the checks.\n2. Push to main.\n3. Watch the deploy log for 5 minutes.\n4. Post the sha in the room.");
const DEPLOY_OLD = skill("deploy-notes", "Use when you ship the fixture app.\n\n1. Run the checks.\n2. Ask for a review.\n3. Push to main.\n4. Post the sha in the room.");

export function writeFixtureSet(dir: string, opts: { reviewDir: string; name?: string; box?: string }): FixtureSet {
  const root = resolve(dir);
  const name = opts.name ?? "fixture";
  const box = opts.box ?? "us-metal02";
  if (!/^[\w.-]+$/.test(name) || name === "live") throw new Error(`A fixture set's name is letters, digits, dots and dashes, and not live; got ${name}.`);
  if (existsSync(root) && readdirSync(root).length) throw new Error(`${root} is not empty; a fixture set goes in a new or empty folder.`);
  const at = new Date().toISOString();
  const rows: Row[] = [];
  const file = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const add = (row: { name: string; box?: string; dir: string; family: string; group: string; verdict: "keep" | "remove" | "merge" | null; reason?: string; mergeInto?: string; how: string; text: string; kind?: string; file?: string; entryId?: string; lastChange?: Row }) => {
    const rowBox = row.box ?? box;
    const path = row.file ?? (row.dir.startsWith("harness:") ? row.dir : join(row.dir, "SKILL.md"));
    if (!row.dir.startsWith("harness:")) file(path, row.text);
    rows.push({
      id: `${rowBox}:${row.dir}`, name: row.name, kind: row.kind ?? "ours", group: row.group, description: `The fixture's ${row.name}.`, box: rowBox, path, dir: row.dir,
      links: [], runtimes: ["claude"], family: row.family, upstream: null, duplicateOf: [], flags: [],
      useful: { verdict: row.verdict, reason: row.reason ?? null, mergeInto: row.mergeInto ?? null, action: row.verdict === "remove" || row.verdict === "merge" },
      loadedBy: { how: [row.how], agents: [], agentsCount: 0, sessions30d: 0 }, uses7d: 0, uses30d: row.verdict === "keep" ? 4 : 0, sessions7d: 0,
      uses: row.verdict === "keep" ? [{ at, session: "fixture", agent: "fixture", how: "read SKILL.md", runtime: "pi-host", box: rowBox }] : [],
      hash: null, sizeBytes: Buffer.byteLength(row.text), files: 1, lines: row.text.split("\n").length, lastChange: row.lastChange ?? null, deadRefs: [],
      text: rowBox === box ? null : row.text, entryId: row.entryId ?? null,
    });
  };
  const home = join(root, "home");
  const mac = join(root, "mac/Users/owner");

  add({ name: "deploy-notes", dir: join(home, "src/tools/skills/deploy-notes"), family: "sieun-pi", group: "fixture", verdict: "keep", reason: "Sessions use it.", how: "prime-sync link", text: DEPLOY });
  add({ name: "deploy-notes", dir: join(home, ".claude/skills/deploy-notes"), family: "user:.claude/skills", group: "Claude Code user skills", verdict: "remove", reason: "A second copy of deploy-notes.", how: "~/.claude/skills", text: DEPLOY });
  add({ name: "deploy-notes", dir: join(home, ".codex/skills/deploy-notes"), family: "user:.codex/skills", group: "Codex user skills", verdict: "remove", reason: "An older copy of deploy-notes that still asks for a review.", how: "~/.codex/skills", text: DEPLOY_OLD });

  add({ name: "release-steps", dir: join(home, ".claude/skills/release-steps"), family: "user:.claude/skills", group: "Claude Code user skills", verdict: "merge", reason: "One rule that belongs in deploy-notes.", mergeInto: "deploy-notes", how: "~/.claude/skills", text: skill("release-steps", "Tag the release after the deploy log is clean.") });

  for (const chart of ["bar-chart", "line-chart", "pie-chart"]) {
    add({ name: chart, dir: join(home, `.claude/plugins/cache/fixture-market/chart-kit/1.0.0/skills/${chart}`), family: "claude-plugin", group: "Claude Code plugins", verdict: "remove", reason: "A Claude Code plugin skill that no session invoked in 30 days.", how: "Claude Code plugin chart-kit", kind: "upstream", text: skill(chart, `Draw a ${chart.replace("-", " ")} with chart-kit.`) });
  }

  add({ name: "screen-notes", box: "mac", dir: join(mac, ".claude/skills/screen-notes"), family: "user:.claude/skills", group: "Claude Code user skills", verdict: "remove", reason: "Synced from claude.ai and never used here.", how: "~/.claude/skills", text: skill("screen-notes", "Take notes on a screen recording.") });

  const repo = join(root, "repo");
  const helper = skill("old-helper", "Run the old build helper before each push.");
  file(join(repo, "README.md"), "The fixture repo.\n");
  file(join(repo, "skills/old-helper/SKILL.md"), helper);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "skills review fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture repo");
  const sha = git("rev-parse", "HEAD");
  const change = { repo, sha, at, author: "skills review fixture", subject: "fixture repo" };
  add({ name: "old-helper", dir: join(repo, "skills/old-helper"), family: "repo:fixture", group: "repo fixture", verdict: "remove", reason: "A helper for a build step the repo dropped.", how: "repo .agents/skills (fixture)", text: helper, lastChange: change });
  add({ name: "old-helper", box: "mac", dir: join(root, "mac/Users/owner/Documents/Github/fixture/skills/old-helper"), family: "repo:fixture", group: "repo fixture", verdict: "remove", reason: "A helper for a build step the repo dropped.", how: "repo .agents/skills (fixture)", text: helper });

  const boardRules = skill("board-rules", "Keep each board step to one line.\n\nClose a step once its sha is released.");
  add({ name: "board-rules", dir: join(home, "src/tools/skills/board-rules"), family: "sieun-pi", group: "fixture", verdict: "keep", reason: "Sessions use it.", how: "prime-sync link", text: boardRules });
  const harnessStore = join(root, "harness");
  const entryId = "fixture_board_note";
  const note = "Keep each board step to one line.";
  add({ name: "board-rules", dir: `harness:memory:${entryId}`, family: "harness-memory", group: "harness notes", verdict: "remove", reason: "It repeats a line board-rules already has.", how: "Prime continual harness (global)", kind: "rule", text: note, entryId });
  const entry = { id: entryId, kind: "memory", title: "Board steps are one line", content: note, path: "fixture", scope: "global", reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: at, updated_at: at, version: 1 };
  file(join(harnessStore, "harness_state.json"), JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { [entryId]: entry }, skill: {}, subagent: {} }, refinements: [] }, null, 2) + "\n");

  const inventory = join(root, "inventory.json");
  file(inventory, JSON.stringify({ generatedAt: at, definition: "The skills review fixture.", boxes: [{ box, scannedAt: at, ok: true, error: null }, { box: "mac", scannedAt: at, ok: true, error: null }], counts: {}, skills: rows }, null, 2) + "\n");
  const stateDir = join(root, "review");
  mkdirSync(stateDir, { recursive: true });
  const setFile = join(resolve(opts.reviewDir), "sets", `${name}.json`);
  file(setFile, JSON.stringify({ inventory, stateDir, root, macHost: null, harnessStore, box }, null, 2) + "\n");
  return { name, root, inventory, stateDir, harnessStore, setFile };
}
