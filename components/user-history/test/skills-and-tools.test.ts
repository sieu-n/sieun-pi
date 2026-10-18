import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS, type Deps } from "../scripts/duties/skills-and-tools.ts";

const asideTabs = CHECKS.find(check => check.id === "aside_tabs")!;
const deps = (platform?: NodeJS.Platform): Deps => ({
  exec: async () => ({ code: 0, stdout: "", stderr: "", ms: 0 }),
  mcp: async () => ({ tools: [], error: "connection closed" }),
  readFile: async () => JSON.stringify({ mcpServers: { aside: { command: "/home/sieun/.local/bin/aside", args: ["mcp"] } } }),
  writeFile: async () => {},
  rm: async () => {},
  exists: async () => true,
  realpath: async path => path,
  list: async () => [],
  loadResolver: async () => async () => undefined,
  home: "/home/sieun",
  repo: "/repo",
  scratchDir: "/tmp",
  now: () => 0,
  ...(platform ? { platform } : {}),
});

test("aside_tabs on the linux box points the fix at the Mac over ssh", async () => {
  const outcome = await asideTabs.run(deps("linux"));
  assert.equal(outcome.status, "fail");
  assert.ok(outcome.status === "fail" && outcome.fix.includes("ssh mac open -a Aside"), JSON.stringify(outcome));
});

test("aside_tabs on macOS keeps the local open -a Aside fix", async () => {
  const outcome = await asideTabs.run(deps());
  assert.ok(outcome.status === "fail" && outcome.fix.startsWith("open Aside with `open -a Aside`"), JSON.stringify(outcome));
});
