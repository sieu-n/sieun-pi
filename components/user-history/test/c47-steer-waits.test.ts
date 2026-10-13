import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkMessage, messageCheckPrelude } from "../src/message-limit-check.ts";
import { goWait } from "../src/shared/chat-board.ts";
import { steerWait } from "../src/shared/steer-wait.ts";

// c47, repeated by the owner in VP of CI at 2026-10-12T14:12:10Z: "look, be fucking aggressive. it's ok to break things. just make it work.
// NEVER wait for something, or ask for my permission to push to Github etc." Thirteen minutes before, VP of CI held four jobs with this
// agent message, which no check read. The board and brief checks (c709ef0) landed after; on 10-12 and 10-13 the chats still held jobs by message.
/** VP of CI to its jobs land run reuse, ship command build, probe overlap rule and signed in e2e at 2026-10-12T13:59:16Z, verbatim. */
const HOLD_1359 = "From the VP of CI. Fable cancelled our pushes on purpose, and nothing was red. The staging branch moved, but land 32b's staging deploy jobs still need the m1-air runners. Re-push the SAME object to a fresh ref (an -r2 name) only when I forward Fable's 'ON STAGING' word, at about 14:15Z or later. Don't push on the branch move. Report the new run id then, naming the run it replaces.";
/** Holds the chats sent their jobs after c709ef0, verbatim sentences: api portal vp 10-12 15:50Z, Crawler VP 10-13 05:04Z, SEO guy 10-12 16:43Z. */
const HOLDS = ["No push until I relay Fable's go.", "Wait for my relay of Fable's go.", "Build the remaining parts, then push them after I relay Fable's go, in one or two objects."];
/** Messages that hold nothing: a report of another thread's word, an "OK," reply, a prediction, verbatim from the Crawler VP and VP of CI. */
const FREE = [
  "From Crawler ops, Fable's word: the 06:03Z cancels were Fable unsticking land 33's 'land / light' job, since the candidate passed at 05:55Z.",
  "From Crawler ops: OK, restart at 2 rows/s once a 5-min read shows IO avg300 under 3%, with sample_percent back at 100. Promote 8 is done.",
  "Since r6 has the same tree plus the test fix, r5's lint will go red anyway, and I'll ask Fable to cancel r5 when its inbox drains, so r6 gets those slots.",
  "From the VP of CI, OWNER ORDER: be aggressive and never wait. Push NOW, without waiting for Fable's word: re-push your same object to a fresh -r2 ci/ ref at once.",
  "Ops guy's job sets it up with the owner's password and runs session 2 again.",
];

test("c47: a message that holds a job for another thread's go is a wait; a report, a reply or an order to push now is not", () => {
  assert.deepEqual(steerWait(HOLD_1359), { kind: "thread", phrase: "Fable's 'ON STAGING' word" });
  for (const text of HOLDS) assert.equal(steerWait(text)?.kind, "thread", text);
  for (const text of FREE) assert.equal(steerWait(text), null, text);
});

test("c47: checkMessage refuses the hold only on a message to a job; a sibling thread may hear what we wait for", async () => {
  assert.match(await checkMessage(HOLD_1359, undefined, "child") ?? "", /^Refused, not sent: this message tells your job to wait\. It waits for another thread's go, word or slot \("Fable's 'ON STAGING' word"\)\. Staging, sieun\/dev, ci\/ and other GitHub pushes/);
  assert.equal(await checkMessage(HOLD_1359, undefined, "sibling"), null);
  assert.equal(await checkMessage(FREE[3]!, undefined, "child"), null);
});

test("c47: in the kernel, agent_message.send of the 13:59Z hold to a job raises LimitRefused and the host gets nothing; the same text to a sibling goes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c47-steer-"));
  try {
    await writeFile(join(dir, "rlm.py"), "sent = []\nasync def host_request(request_type, payload=None):\n    sent.append(payload)\n    return {'deliveryStatus': 'delivered'}\n");
    await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\nasync def send(message, *, receiver_role=None, receiver_name=None):\n" +
      "    return await host_request('agent_message.send', {'message': message, 'receiver_role': receiver_role, 'receiver_name': receiver_name})\n");
    const script = messageCheckPrelude(dir) + [
      "import asyncio, json, sys, agent_message, rlm",
      "async def main(sends):",
      "    out = []",
      "    for text, role in sends:",
      "        try:",
      "            await agent_message.send(text, receiver_role=role, receiver_name='land run reuse')",
      "            out.append('sent')",
      "        except Exception as error:",
      "            out.append(type(error).__name__)",
      "    print(json.dumps({'out': out, 'sent': [p['receiver_role'] for p in rlm.sent]}))",
      "asyncio.run(main(json.load(sys.stdin)))",
    ].join("\n");
    const run = spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, encoding: "utf8",
      input: JSON.stringify([[HOLD_1359, "child"], [HOLD_1359, "sibling"], [FREE[3], "child"]]) });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)!), { out: ["LimitRefused", "sent", "sent"], sent: ["sibling", "child"] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("c47: goWait reads a whole word after the possessive, skips it's and that's, and an \"OK,\" that opens a sentence is a reply", () => {
  // VP of CI to a job, 10-13 10:19Z: "setup-node's node" read as "setup-node's nod"; Crawler VP, 10-13 13:51Z: "it's a full ACK" read as a thread's ack.
  assert.equal(goWait("Push it once the metal jobs run setup-node's node 22."), null);
  assert.equal(goWait("Push the chain once it's a full ACK of the bytes."), null);
  assert.equal(goWait("From Crawler ops: OK, restart at 2 rows/s once a 5-min read shows IO avg300 under 3%."), null);
  assert.equal(goWait("Push once g-jev2 OKs it.")?.phrase, "OKs", "an OK from another thread still counts");
  assert.equal(goWait("Push it once you have metal's ack.")?.phrase, "metal's ack");
});
