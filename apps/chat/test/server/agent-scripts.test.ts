import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentScripts, precheckScript } from "../../server/agent-scripts.ts";
import type { Duty } from "../../web/src/lib/api/shared/chat-duties.ts";

const root = mkdtempSync(join(tmpdir(), "agent-scripts-"));
after(() => rmSync(root, { recursive: true, force: true }));

const file = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "// a script\n");
  return path;
};
const duty = (id: string, command: string[], cwd: string) => ({ id, name: `duty ${id}`, precheck: { command, cwd, timeoutMs: 1000 } }) as unknown as Duty;

test("lists the folder's scripts, the brief's and the duties' prechecks, once each and only when the file exists", () => {
  const home = join(root, "home");
  const folder = join(home, "agents", "vent");
  const cwd = join(home, "repo");
  file(join(folder, "brief.md"));
  const scan = file(join(folder, "scan.py"));
  const tool = file(join(folder, "tools", "check.mjs"));
  file(join(folder, "harness", "kept.py"));
  file(join(folder, "jobs", "2026", "run.py"));
  const capture = file(join(home, "work", "asks", "capture.py"));
  const release = file(join(cwd, "scripts", "release.mjs"));
  const precheck = file(join(cwd, "scripts", "duties", "gateway.ts"));
  symlinkSync(release, join(cwd, "release-link.mjs"));

  const brief = [
    "Measure with `~/work/asks/capture.py` and scripts/release.mjs <sha>.",
    "Also release-link.mjs, which is the same file, and scripts/missing.mjs, which is not there.",
    "Its folder holds scan.py, named again here: " + scan,
  ].join("\n");
  const duties = [duty("d1", ["node", "--import", "tsx", "scripts/duties/gateway.ts"], cwd), duty("d2", ["node", "-e", "require('fs')"], cwd), duty("d3", ["true"], "/tmp")];

  const scripts = agentScripts({ folderDir: folder, brief, cwd, home, duties });
  assert.deepEqual(scripts.map(s => [s.path, s.from]), [
    [scan, { kind: "folder" }],
    [tool, { kind: "folder" }],
    [capture, { kind: "brief" }],
    [release, { kind: "brief" }],
    [precheck, { kind: "duty", duty: "d1", name: "duty d1" }],
  ]);
  assert.ok(scripts.every(s => s.modifiedAt > 0));
});

test("an agent with no folder, brief or duties has no scripts", () => {
  assert.deepEqual(agentScripts({ folderDir: join(root, "none"), brief: "", cwd: root, home: root, duties: [] }), []);
});

test("a precheck's script is its first argument that names a script file", () => {
  assert.equal(precheckScript(["node", "--import", "tsx", "scripts/duties/a.ts", "--agent", "x.ts"], "/srv"), "/srv/scripts/duties/a.ts");
  assert.equal(precheckScript(["node", "scripts/duties/search/prod-mcp.mjs"], "/repo"), "/repo/scripts/duties/search/prod-mcp.mjs");
  assert.equal(precheckScript(["true"], "/tmp"), null);
});
