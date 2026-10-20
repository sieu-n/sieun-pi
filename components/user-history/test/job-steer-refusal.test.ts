// Guards the 10-20 05:59Z to 06:03Z d7 dirty minutes: a check-in job's job-steer.ts got the chat service's own 502 for a Mac job ("Ambiguous
// resident session path", a daemon refusal), read it as a service restart, and asked again every 3 s for 60 s, three runs and 62 refusals.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { restartAnswer } from "../src/chat-host.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function steer(t: { after(fn: () => Promise<void>): void }, answers: ((res: ServerResponse) => void)[]): Promise<{ code: number; out: string; asked: number }> {
  let asked = 0;
  const server = createServer((req, res) => { req.resume(); req.on("end", () => { answers[Math.min(asked, answers.length - 1)]!(res); asked++; }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "job-steer-"));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "token", port: (server.address() as AddressInfo).port, capability: "cap" }));
  const env = { ...process.env, AGENT_CHAT_DATA_DIR: dir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json") };
  return await new Promise(resolve => {
    execFile(process.execPath, ["--import", "tsx", "scripts/job-steer.ts", "01a15503-17d5-7664-b38b-4bba793ed5cd", "virev mcp db tools ship", "push p3"],
      { cwd: ROOT, env, timeout: 90_000 }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr, asked }));
  });
}

const json = (status: number, body: unknown) => (res: ServerResponse) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const bare = (status: number) => (res: ServerResponse) => { res.writeHead(status); res.end(); };

test("job-steer.ts takes the chat service's own 502 as its answer and does not ask again", async t => {
  const refusal = 'Ambiguous resident session path "/Users/sieunpark/.prime/agent/session-artifacts/01a15503-17d5-7664-b38b-4bba793ed5cd/sub-dc575798/01a156cd.jsonl"';
  const run = await steer(t, [json(502, { error: refusal })]);
  assert.equal(run.asked, 1);
  assert.equal(run.code, 1);
  assert.match(run.out, /job-steer: 502 .*Ambiguous resident session path/);
});

test("job-steer.ts asks again through a restart's bare 502 and then reports the steer", async t => {
  const run = await steer(t, [bare(502), json(200, { act: "steer", session: "01a156cd-bbb6-72dd-8f17-943549b9d8a6" })]);
  assert.equal(run.asked, 2);
  assert.equal(run.code, 0);
  assert.match(run.out, /steered virev mcp db tools ship/);
});

test("restartAnswer reads a 503 and a bare 502 or 504 as a restart, and the service's JSON 502 as its answer", () => {
  assert.equal(restartAnswer(503, JSON.stringify({ error: "Another box has not listed its sessions yet; try again shortly." })), true);
  assert.equal(restartAnswer(502, ""), true);
  assert.equal(restartAnswer(504, "<html>Gateway Timeout</html>"), true);
  assert.equal(restartAnswer(502, JSON.stringify({ error: "Ambiguous resident session path" })), false);
  assert.equal(restartAnswer(500, ""), false);
});
