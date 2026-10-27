// Guards 10-25 07:45Z, when a one-process run of the whole suite (--test-isolation=none) loaded src/host-catalogs.ts with the real HOME, and
// mac-offline-first-frame.test.ts, which points HOME at a temp folder first, then wrote its 2 fixture rows over ~/.cache/sieun-pi/hosts/mac.sessions.json.
// d9 then could not place 5 held steps on the offline Mac and read stuck_steps_all 5. Each module that writes under HOME reads it at each call.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const first = mkdtempSync(join(tmpdir(), "home-at-call-first-"));
const second = mkdtempSync(join(tmpdir(), "home-at-call-second-"));
const saved = process.env.HOME;
process.env.HOME = first;
const { copyPath, mirrorDir, mirrorPath, remotePath } = await import("../src/host-catalogs.ts");
const { HostBridge, bridgeDir, parseHosts } = await import("../src/hosts.ts");
const { artifactsRoot, ownedRoots } = await import("../src/job-leftovers.ts");
const { wikiContentDir } = await import("../src/chat-wiki.ts");
const { orphanServicesDir } = await import("../src/orphan-services.ts");

test("a module loaded under one HOME writes under the HOME of the test that runs after it", t => {
  process.env.HOME = second;
  t.after(() => { process.env.HOME = saved; rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); });
  const mac = { name: "mac" };
  const registry = parseHosts({ version: 1, hosts: [
    { name: "us-metal02", hostname: "us-metal02", address: "127.0.0.2", relayPort: 1, token: "file:relay-tokens/mac", daemonSocket: "/tmp/box.sock", roles: {} },
    { name: "mac", hostname: "Sieuns-MacBook-Pro", address: "127.0.0.1", relayPort: 2, token: "file:relay-tokens/mac", daemonSocket: "/tmp/mac.sock", roles: {} }] });
  const paths = {
    copy: copyPath("mac"),
    mirror: mirrorPath(mac, "/Users/sieunpark/.prime/agent/sessions/a.jsonl"),
    mirrorDir: mirrorDir(),
    bridge: new HostBridge(registry, { self: registry.hosts[0]! }).socketPath("mac"),
    bridgeDir: bridgeDir(),
    artifacts: artifactsRoot(),
    owned: ownedRoots().filter(root => root !== "/tmp").join(" "),
    wiki: wikiContentDir(),
    orphans: orphanServicesDir(),
  };
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(!path.includes(first), `${name} still points under the HOME the module loaded with: ${path}`);
    assert.ok(path.startsWith(second + "/"), `${name} is not under the current HOME: ${path}`);
  }
  assert.equal(remotePath(mac, paths.mirror), "/Users/sieunpark/.prime/agent/sessions/a.jsonl");
});
