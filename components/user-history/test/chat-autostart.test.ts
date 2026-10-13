import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchAgentPlist, loginItemCli } from "../src/chat-autostart.ts";

test("login item: a release started through current writes a plist that names current, not the release folder", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "login-item-")));
  try {
    const cli = join(root, "release-abc1234", "components", "user-history", "src", "chat-service-cli.mjs");
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "console.log(JSON.stringify({ started: process.argv[1], resolved: new URL(import.meta.url).pathname }));\n");
    symlinkSync(join(root, "release-abc1234"), join(root, "current"));
    const viaCurrent = join(root, "current", "components", "user-history", "src", "chat-service-cli.mjs");
    // What the service sees when launchd runs it through current: Node keeps argv[1] as given and resolves import.meta.url.
    const run = spawnSync(process.execPath, [viaCurrent], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const seen = JSON.parse(run.stdout) as { started: string; resolved: string };
    assert.deepEqual(seen, { started: viaCurrent, resolved: cli });
    const named = loginItemCli(seen.started, seen.resolved);
    assert.equal(named, viaCurrent);
    const plist = launchAgentPlist({ node: "/opt/node/bin/node", cli: named, dataDir: "/d", port: 5182, socketPath: "/s.sock", logPath: "/d/service.log" });
    assert.ok(plist.includes(`<string>${viaCurrent}</string>`) && !plist.includes("release-abc1234"), plist);
    assert.equal(loginItemCli(cli, cli), cli, "started from the release folder itself, it names that folder");
    assert.equal(loginItemCli(undefined, cli), cli, "no argv[1]: the resolved path");
    assert.equal(loginItemCli(join(root, "other.mjs"), cli), cli, "another script started the process (the extension, a test): the resolved path");
    assert.equal(loginItemCli(join(root, "gone", "chat-service-cli.mjs"), cli), cli, "a started path that is not the same file: the resolved path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("login item: PATH carries the user's ~/.local/bin once, so duty scripts find uv", () => {
  const job = { node: "/opt/node/bin/node", cli: "/c/chat-service-cli.mjs", dataDir: "/d", port: 5182, socketPath: "/s.sock", logPath: "/d/service.log" };
  const pathOf = (plist: string) => /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  assert.equal(pathOf(launchAgentPlist({ ...job, home: "/Users/someone" })),
    "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/Users/someone/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(pathOf(launchAgentPlist({ ...job, node: "/Users/someone/.local/bin/node", home: "/Users/someone" })),
    "/Users/someone/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "a node in ~/.local/bin is listed once");
  assert.ok(pathOf(launchAgentPlist(job))?.split(":").includes(join(homedir(), ".local", "bin")), "home defaults to os.homedir()");
});
