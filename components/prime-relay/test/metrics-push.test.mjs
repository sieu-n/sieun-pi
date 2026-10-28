import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { feedCpuGroups } from "../host-stats.ts";
import { groupPoints, otlpBody, startGroupPush } from "../metrics-push.ts";

const points = (body, name) => JSON.parse(body).resourceMetrics[0].scopeMetrics[0].metrics.find(metric => metric.name === name)?.gauge.dataPoints
  .map(point => [point.attributes[0].value.stringValue, point.asDouble]);

test("otlpBody sends every group of each side as a gauge, a missing group at 0, with service.name prime-relay", () => {
  const body = otlpBody({ cpu: [{ id: "agents", cores: 3.5 }, { id: "system", cores: 1.25 }], memory: [{ id: "jobs", bytes: 2e9 }] }, 1793210000000);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.resourceMetrics[0].resource.attributes, [{ key: "service.name", value: { stringValue: "prime-relay" } }]);
  const cpu = Object.fromEntries(points(body, "host_cpu_group_cores"));
  assert.equal(cpu.agents, 3.5);
  assert.equal(cpu.system, 1.25);
  assert.equal(cpu.browsers, 0);
  assert.equal("files" in cpu, false);
  const memory = Object.fromEntries(points(body, "host_mem_group_bytes"));
  assert.equal(memory.jobs, 2e9);
  assert.equal(memory.files, 0);
  assert.equal(parsed.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].timeUnixNano, "1793210000000000000");
});

test("otlpBody leaves out a side the reading lacks, and sends nothing when it lacks both", () => {
  const body = otlpBody({ cpu: null, memory: [{ id: "agents", bytes: 1 }] });
  assert.equal(points(body, "host_cpu_group_cores"), undefined);
  assert.equal(otlpBody({ cpu: null, memory: null }), null);
});

test("groupPoints sums repeats of one group", () => {
  assert.deepEqual(groupPoints([{ id: "jobs", value: 1 }, { id: "jobs", value: 2 }], ["jobs", "ci"]), [{ group: "jobs", value: 3 }, { group: "ci", value: 0 }]);
});

test("feedCpuGroups turns the Mac feed's cpu_pct into cores by group, kernel_task in System, and refuses a stale feed", () => {
  const now = Date.parse("2026-10-28T18:06:40Z");
  const feed = { v: 1, ts: "2026-10-28T18:06:32.487Z", kernel_task_cpu_pct: 41.7, owners: [
    { owner: "browser:helium", label: "Helium", mem_gb: 12.49, cpu_pct: 70.3 }, { owner: "browser:chrome", label: "Google Chrome", mem_gb: 5.98, cpu_pct: 34.8 },
    { owner: "chat:abc", label: "chat", mem_gb: 1, cpu_pct: 150 }, { owner: "other:rest", label: "rest", mem_gb: 3.53, cpu_pct: 39.8 }] };
  const cores = Object.fromEntries(feedCpuGroups(feed, now).map(group => [group.id, group.cores]));
  assert.deepEqual(cores, { browsers: 1.05, agents: 1.5, other: 0.4, system: 0.42 });
  assert.equal(feedCpuGroups(feed, now + 60_000), null);
});

test("startGroupPush posts one reading to the OTLP url and logs a failure once until it works again", async t => {
  const bodies = [];
  let status = 500;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push({ path: request.url, type: request.headers["content-type"], body });
    response.writeHead(status).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/metrics`;
  const lines = [];
  const read = async () => ({ cpu: [{ id: "ci", cores: 2 }], memory: null });
  const stop = startGroupPush(line => lines.push(line), url, read);
  t.after(stop);
  while (bodies.length < 1 || lines.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(bodies[0].path, "/v1/metrics");
  assert.equal(bodies[0].type, "application/json");
  assert.equal(Object.fromEntries(points(bodies[0].body, "host_cpu_group_cores")).ci, 2);
  assert.match(lines[0], /^metrics push: .* answered 500/);
  stop();
  status = 200;
  const again = startGroupPush(line => lines.push(line), url, read);
  t.after(again);
  while (bodies.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(lines.length, 1);
});
