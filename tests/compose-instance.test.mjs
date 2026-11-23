// The dev instance's compose.yaml: its config resolves with the services the tutorial names, no service listens on a live port, and the
// fixture profile comes up healthy from an empty volume and answers /api/agents. The start part needs Docker and skips without it.
// Run: node --test --test-force-exit tests/compose-instance.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compose = (args, env = {}) => spawnSync("docker", ["compose", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
const noDocker = docker.error || docker.status !== 0 ? "needs a Docker daemon" : false;
/** The live chat (5184), the old chat (5182) and the fixture server (5186) of the box. */
const LIVE_PORTS = ["5182", "5184", "5186"];

test("compose.yaml resolves with meili, pi-host and chat, the fixture profile, and no live port", { skip: noDocker }, () => {
  const run = compose(["--profile", "fixture", "config", "--format", "json"]);
  assert.equal(run.status, 0, run.stderr);
  const config = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(config.services).sort(), ["chat", "fixture", "meili", "pi-host"]);
  assert.deepEqual(config.services.fixture.profiles, ["fixture"]);
  for (const [name, service] of Object.entries(config.services)) {
    assert.ok(service.healthcheck?.test, `${name} has a healthcheck`);
    assert.equal(service.deploy?.resources, undefined, `${name} sets no resource limit (c107)`);
    for (const arg of service.command ?? []) assert.ok(!LIVE_PORTS.includes(String(arg)), `${name} runs on no live port: ${service.command.join(" ")}`);
    for (const port of service.ports ?? []) assert.ok(!LIVE_PORTS.includes(String(port.published)) && !LIVE_PORTS.includes(String(port.target)), `${name} publishes no live port`);
    for (const volume of service.volumes ?? []) assert.ok(!/\/\.pi\/|\/\.prime\//.test(volume.source ?? ""), `${name} mounts nothing of the live instance: ${volume.source}`);
  }
});

const freePort = () => new Promise(resolve => {
  const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const project = `swf-check-${process.pid}`;
after(() => { if (!noDocker) compose(["-p", project, "--profile", "fixture", "down", "-v", "--remove-orphans"]); });

test("docker compose up fixture comes up healthy from an empty volume and answers /api/agents", { skip: noDocker }, async () => {
  const port = await freePort();
  const env = { SWF_FIXTURE_PORT: String(port) };
  const up = compose(["-p", project, "up", "-d", "--build", "--wait", "fixture"], env);
  assert.equal(up.status, 0, `${up.stdout}\n${up.stderr}`);
  const ready = await (await fetch(`http://127.0.0.1:${port}/api/ready`)).json();
  assert.equal(ready.ready, true);
  const agents = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
  assert.ok(Array.isArray(agents) && agents.length > 0, "the fixture seeds agents");
  const again = compose(["-p", project, "up", "-d", "--wait", "fixture"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /Recreat|Creating/, "a second up changes nothing");
});
