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

const railwayAuth = CHECKS.find(check => check.id === "railway_auth")!;
const railwayDeps = (token: string | undefined): Deps => ({
  ...deps("linux"),
  env: token === undefined ? {} : { RAILWAY_API_TOKEN: token },
  exec: async (_file, _args, options) => options.env?.RAILWAY_API_TOKEN && options.env.HOME !== "/home/sieun"
    ? { code: 1, stdout: "", stderr: "Unauthorized. Please check that your RAILWAY_API_TOKEN is valid", ms: 0 }
    : { code: 0, stdout: "Logged in as Sieun Park (sieunpark77@gmail.com)", stderr: "", ms: 0 },
});

test("railway_auth fails a broken RAILWAY_API_TOKEN that the OAuth login would hide", async () => {
  const outcome = await railwayAuth.run(railwayDeps("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
  assert.ok(outcome.status === "fail" && outcome.fix.includes("railway.com/account/tokens"), JSON.stringify(outcome));
});

test("railway_auth names the inline comment when RAILWAY_API_TOKEN carries one", async () => {
  const outcome = await railwayAuth.run(railwayDeps('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"  # PERSONAL account token'));
  assert.ok(outcome.status === "fail" && outcome.fix.includes("inline comment"), JSON.stringify(outcome));
});

test("railway_auth without RAILWAY_API_TOKEN keeps the OAuth whoami", async () => {
  const outcome = await railwayAuth.run(railwayDeps(undefined));
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
});
