/**
 * A folder gives a pi thread its AGENTS.md and then its CLAUDE.md, where Prime's loader takes only the first, and a file whose text the
 * other already holds stays out: a CLAUDE.md that only imports `@AGENTS.md`, a link to it, a copy inside it, or a blank one. A thread's
 * prompt shows both files, and apps/chat's config page lists both as loaded.
 * Run: cd packages/pi-host && node --import tsx --test --test-force-exit --test-isolation=none test/durable/context-files.test.ts
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { instructionFiles } from "../../../../apps/chat/server/agent-folder.ts";
import { folderContextFiles, withFolderFiles } from "../../src/durable/context-files.ts";
import { primePromptParts } from "../../src/durable/prime-prompt.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-context-files-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);

const AGENTS = "# Repo rules\n\nCLAUDE.md holds the repo map.\n";
const CLAUDE = "# Repo map\n\nThe crawler lives in apps/crawler-v3.\n";

function folder(name: string, files: Record<string, string>): string {
  const at = join(dir, name);
  mkdirSync(at, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(at, file), text);
  return at;
}
const names = (at: string): string[] => folderContextFiles(at).map(file => file.path.slice(at.length + 1));

test("a folder gives its AGENTS.md and then its CLAUDE.md", () => {
  const at = folder("both", { "AGENTS.md": AGENTS, "CLAUDE.md": CLAUDE });
  assert.deepEqual(folderContextFiles(at), [{ path: join(at, "AGENTS.md"), content: AGENTS }, { path: join(at, "CLAUDE.md"), content: CLAUDE }]);
  assert.deepEqual(names(folder("agents-only", { "AGENTS.md": AGENTS })), ["AGENTS.md"]);
  assert.deepEqual(names(folder("claude-only", { "CLAUDE.md": CLAUDE })), ["CLAUDE.md"]);
  assert.deepEqual(names(folder("none", {})), []);
});

test("a file whose text the other already holds stays out", () => {
  assert.deepEqual(names(folder("import", { "AGENTS.md": AGENTS, "CLAUDE.md": "@AGENTS.md\n" })), ["AGENTS.md"], "sieun-pi's own CLAUDE.md");
  assert.deepEqual(names(folder("import-dot", { "AGENTS.md": AGENTS, "CLAUDE.md": "\n@./AGENTS.md\n\n" })), ["AGENTS.md"]);
  assert.deepEqual(names(folder("blank", { "AGENTS.md": AGENTS, "CLAUDE.md": " \n" })), ["AGENTS.md"]);
  assert.deepEqual(names(folder("copy", { "AGENTS.md": `${AGENTS}\n${CLAUDE}`, "CLAUDE.md": CLAUDE })), ["AGENTS.md"]);
  assert.deepEqual(names(folder("superset", { "AGENTS.md": AGENTS, "CLAUDE.md": `${CLAUDE}\n${AGENTS}` })), ["CLAUDE.md"], "the CLAUDE.md that holds the AGENTS.md text replaces it");
  const linked = folder("link", { "AGENTS.md": AGENTS });
  symlinkSync(join(linked, "AGENTS.md"), join(linked, "CLAUDE.md"));
  assert.deepEqual(names(linked), ["AGENTS.md"]);
  assert.deepEqual(names(folder("other-import", { "AGENTS.md": AGENTS, "CLAUDE.md": "@docs/map.md\n" })), ["AGENTS.md", "CLAUDE.md"], "an import of another file is new text");
});

test("Prime's list gets each folder's whole set in Prime's folder order", () => {
  const outer = folder("tree", { "AGENTS.md": AGENTS, "CLAUDE.md": CLAUDE });
  const inner = folder("tree/sub", { "CLAUDE.md": "# Sub\n" });
  const prime = [{ path: join(outer, "AGENTS.md"), content: AGENTS }, { path: join(inner, "CLAUDE.md"), content: "# Sub\n" }];
  assert.deepEqual(withFolderFiles(prime).map(file => file.path), [join(outer, "AGENTS.md"), join(outer, "CLAUDE.md"), join(inner, "CLAUDE.md")]);
});

test("a thread's prompt holds both files, and the config page lists both as loaded", async () => {
  const agentDir = join(dir, "agent");
  cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
  const cwd = folder("repo", { "AGENTS.md": AGENTS, "CLAUDE.md": CLAUDE });
  const bundled = folder("bundled", {});
  const parts = await primePromptParts({ agentDir, cwd, depth: 0, bundledSkillsDir: bundled, ledgerDir: join(agentDir, "browser-chat"), primeOnly: true });
  const context = parts.find(part => part.key === "context")!.text;
  assert.ok(context.endsWith(`## ${join(cwd, "AGENTS.md")}\n\n${AGENTS}\n\n## ${join(cwd, "CLAUDE.md")}\n\n${CLAUDE}\n\n`), context);

  const listed = instructionFiles(cwd, agentDir).filter(file => file.path.startsWith(cwd));
  assert.deepEqual(listed.map(file => [file.label, file.loaded, file.note]), [["AGENTS.md in its cwd", true, undefined], ["CLAUDE.md in its cwd", true, undefined]]);
  const skipped = instructionFiles(folder("repo-import", { "AGENTS.md": AGENTS, "CLAUDE.md": "@AGENTS.md\n" }), agentDir).find(file => file.label === "CLAUDE.md in its cwd");
  assert.deepEqual([skipped?.loaded, skipped?.note], [false, "pi-host leaves it out, because the AGENTS.md beside it already holds its text."]);
});
