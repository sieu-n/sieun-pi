// Guards the 10-25 00:46:07 KST case: the AI harness developer environment VP sent its release notice for sieun-pi 9cc887bc to "root disk
// readings", a running clean-room test chat, and the verdict quoted it as someone stepping in, so the run was void. A message to a test chat from
// outside its own sessions now goes to the trial owner, while the chat's own jobs, such as its root job "disk free sampling 2", still reach it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CLEAN_ROOM_SUBJECTS_FILE, fileSubjects, routeMessage, type RouteSources, type Subject } from "../src/clean-room-subjects.ts";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

const SUBJECT = "01a16e1d-6592-73c6-9a96-81184bf35e5a";
const OWNER = "01a16cf7-5ae1-731c-a7b9-d388a8209ff7";
const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const SAMPLER = "01a16e85-0000-7000-8000-000000000001";
const CHECK_IN = "01a16e90-0000-7000-8000-000000000003";
const SUBAGENT = "01a16e86-0000-7000-8000-000000000004";
const SUBJECTS: Record<string, Subject> = { [SUBJECT]: { owner: OWNER, run: "/runs/carried-wait/run-3", name: "root disk readings", at: 0 } };
// run-3's agents list: its own root job and subagent, and the VP, which it lists with link message because the two exchanged messages.
const AGENTS = [{ sessionId: SAMPLER, name: "disk free sampling 2", link: "root" }, { sessionId: SUBAGENT, name: "sampler setup", link: "subagent" },
  { sessionId: VP, name: "AI harness developer environment VP", link: "message" }];
const NOTICE = "From the AI harness chat VP: fixed in sieun-pi 9cc887bc (release-9cc887b). Your check-in's finding is answered.";
const REPORT = "All 16 readings of root disk free space are in; p2 is done.";

const sources = (archived = false, agents = AGENTS): RouteSources => ({ subjects: async () => SUBJECTS, archived: async () => archived,
  participants: async () => ({ agents, dutyJobs: [CHECK_IN] }) });

test("a message to a running test chat from outside its own sessions goes to the trial owner; its own jobs still reach it", async () => {
  const notice = await routeMessage(sources(), { from: VP, fromName: "AI harness developer environment VP", to: SUBJECT, text: NOTICE });
  assert.equal(notice.to, "owner", "a session listed with link message is no participant of the chat");
  assert.equal(notice.to === "owner" && notice.owner, OWNER);
  assert.match(notice.to === "owner" ? notice.text : "", /AI harness developer environment VP \(01a1164b[^)]*\) sent this to "root disk readings"[\s\S]*fixed in sieun-pi 9cc887bc/);
  assert.deepEqual(await routeMessage(sources(), { from: SAMPLER, fromName: "disk free sampling 2", to: SUBJECT, text: REPORT }), { to: "target" },
    "the report of disk free sampling 2, a root job the chat started, reaches the chat");
  assert.deepEqual(await routeMessage(sources(), { from: CHECK_IN, to: SUBJECT, text: "check-in: p3 waits on p2" }), { to: "target" }, "its check-in job reaches it");
  assert.deepEqual(await routeMessage(sources(), { from: SUBAGENT, to: SUBJECT, text: "done" }), { to: "target" }, "its subagent reaches it");
  const impostor = "01a16e99-0000-7000-8000-000000000005";
  const named = await routeMessage(sources(), { from: impostor, fromName: "disk free sampling 2", to: SUBJECT, text: REPORT });
  assert.equal(named.to, "owner", "an own job's name on a different session id is not that job");
  assert.deepEqual(await routeMessage(sources(true), { from: VP, to: SUBJECT, text: NOTICE }), { to: "target" }, "an archived test chat's trial is over");
  assert.deepEqual(await routeMessage(sources(), { from: VP, to: OWNER, text: NOTICE }), { to: "target" }, "a session that is no test chat gets its messages");
});

test("a sibling send to a running test chat returns a redirected receipt and reaches the trial owner; the chat's own root job sends as it came", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clean-room-route-"));
  await fileSubjects(dir, SUBJECTS);
  assert.ok(JSON.parse(await readFile(join(dir, CLEAN_ROOM_SUBJECTS_FILE), "utf8")).subjects[SUBJECT]);
  const delivered: { session: string; text: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const { from, fromName, to, message } = JSON.parse(body || "{}");
      const answer = new URL(req.url!, "http://127.0.0.1").pathname.endsWith("api/agent/route")
        ? routeMessage(sources(), { from, fromName, to, text: message }).then(route => {
          if (route.to === "owner") delivered.push({ session: route.owner, text: route.text });
          return route.to === "owner" ? { redirected: true, owner: route.owner } : { redirected: false };
        })
        : Promise.reject(new Error(`unexpected ${req.url}`));
      answer.then(value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
        error => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await writeFile(join(dir, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/cap/` }));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ csrfToken: "t" }));
  const send = async (me: string, name: string, text: string) => {
    await writeFile(join(dir, "rlm.py"), [
      "import json",
      "async def host_request(request_type, payload=None):",
      "    if request_type == 'agent_message.send':",
      "        open('local-sends.txt', 'a').write(payload['message'] + '\\n')",
      "        return {'deliveryStatus': 'delivered', 'local': True}",
      `    return {'current': {'sessionId': '${me}', 'sessionName': '${name}'},`,
      `            'agents': [{'sessionId': '${SUBJECT}', 'sessionName': 'root disk readings', 'relationship': 'sibling', 'runtimeKind': 'top-level'}]}`,
    ].join("\n") + "\n");
    await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
    await writeFile(join(dir, "agent_observe.py"), "from rlm import host_request\n");
    const sessionDir = join(dir, "session-artifacts", me);
    await mkdir(sessionDir, { recursive: true });
    const script = messageCheckPrelude(dir) + [
      "import asyncio, json, agent_message",
      "async def main():",
      `    print(json.dumps(await agent_message.host_request('agent_message.send', {'message': ${JSON.stringify(text)}, 'receiver_role': 'sibling', 'receiver_name': 'root disk readings'})))`,
      "asyncio.run(main())",
    ].join("\n");
    const run = await promisify(execFile)("python3", ["-c", script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir, RLM_SESSION_DIR: sessionDir, SIEUN_PI_HOSTS: join(dir, "no-hosts.json") } });
    return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  };
  try {
    const notice = await send(VP, "AI harness developer environment VP", NOTICE);
    assert.equal(notice.deliveryStatus, "redirected");
    assert.equal(notice.trialOwner, OWNER);
    assert.match(notice.note, /root disk readings is a clean-room test chat[\s\S]*trial's owner 01a16cf7/);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.session, OWNER);
    assert.match(delivered[0]!.text, /fixed in sieun-pi 9cc887bc/);
    const report = await send(SAMPLER, "disk free sampling 2", REPORT);
    assert.equal(report.local, true, "the chat's own root job sends to it as it came");
    assert.equal(await readFile(join(dir, "local-sends.txt"), "utf8"), REPORT + "\n", "only the root job's report went to the chat");
    assert.equal(delivered.length, 1);
  } finally { server.close(); }
});
