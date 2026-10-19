// Guards 10-18 12:18:05Z on us-metal02: the wake of CI run 39124631211 sent 18 messages into the Crawler VP tree at once, its one worker took
// them one after another while the box read 59% cpu some, and the 11 still waiting at 12:18:35Z each timed out at the daemon's 30 s.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";

const ARTIFACTS = "/home/sieun/.prime/agent/session-artifacts";
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
// Four of the 12:18:05Z targets with their session files, and a root job of another chat whose own worker took its wake alongside.
const FILES: Record<string, string> = {
  "01a14d90-7eca-7229-a422-0c30ef98e47f": `${ARTIFACTS}/${CRAWLER}/sub-1319d85a/sub-15125740/01a14d90-7eca-7229-a422-0c30ef98e47f.jsonl`,
  "01a14e24-197c-730b-9465-e30d44484921": `${ARTIFACTS}/${CRAWLER}/sub-1319d85a/sub-2fbacc46/01a14e24-197c-730b-9465-e30d44484921.jsonl`,
  "01a14d96-b48c-735b-a811-0760b65ab799": `${ARTIFACTS}/${CRAWLER}/sub-55e4935c/01a14d96-b48c-735b-a811-0760b65ab799.jsonl`,
  "01a14eba-e3d6-76c7-ad96-96c6d94ccb74": `${ARTIFACTS}/${CRAWLER}/sub-0c17993d/01a14eba-e3d6-76c7-ad96-96c6d94ccb74.jsonl`,
  "01a14ed4-0000-7000-8000-000000000001": "/home/sieun/.prime/agent/sessions/01a14ed4-0000-7000-8000-000000000001.jsonl",
};
const WAKE = "[wake] Run 39124631211 finished: failure (promote.yml on sieun/dev). https://github.com/sieu-n/auto-sns-agent/actions/runs/39124631211";

test("the wakes of one CI run go into a session tree one at a time, and another tree's wake goes alongside", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outbox-tree-"));
  const out = new Map<string, number>();
  let most = 0, alongside = false;
  const sent: string[] = [];
  // The Crawler VP tree's sends hold until the other tree's send starts, instead of a 20 ms window that the build's load on 10-19 outran
  // (5e5e697 at 14:48Z): its four sends ended before the fifth deliver was called. An outbox that sends one at a time overall never starts it.
  let otherStarted!: () => void;
  const other = new Promise<void>(done => { otherStarted = done; });
  const tree = (session: string) => FILES[session]!.includes(CRAWLER) ? "crawler" : session;
  const outbox = new AgentOutbox(dir, {
    log: () => {},
    send: async session => {
      const key = tree(session);
      out.set(key, (out.get(key) ?? 0) + 1);
      most = Math.max(most, out.get("crawler") ?? 0);
      if (key !== "crawler" && (out.get("crawler") ?? 0) > 0) alongside = true;
      if (key === "crawler") await other; else otherStarted();
      await new Promise(done => setTimeout(done, 20));
      out.set(key, out.get(key)! - 1);
      sent.push(session.slice(0, 8));
      return "sent";
    },
    target: async () => ({ queued: [], busy: false }),
    fileOf: async session => FILES[session] ?? null,
  });
  for (const session of Object.keys(FILES)) await outbox.deliver(session, `${WAKE} ${session}`, CRAWLER);
  await outbox.outbox.idle();
  await outbox.close();
  assert.equal(sent.length, 5);
  assert.equal(most, 1, "sends into the Crawler VP tree at once");
  assert.ok(alongside, "the other tree's wake waited for the Crawler VP tree");
});

test("an outbox line names the box of a session another box runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outbox-host-"));
  const lines: string[] = [];
  const outbox = new AgentOutbox(dir, {
    log: line => { lines.push(line); },
    hostOf: session => session.startsWith("01a11d25") ? "mac" : null,
    send: async session => { if (session.startsWith("01a11d25")) throw new Error("Session worker is failed"); return "sent"; },
    target: async () => ({ queued: [], busy: false }),
    fileOf: async () => null,
    sleep: () => new Promise(done => setImmediate(done)),
  });
  await outbox.deliver("01a11d25-0000-7000-8000-000000000001", "[wake] check");
  await outbox.deliver("01a14efc-0000-7000-8000-000000000002", "[wake] check");
  while (!lines.some(line => line.includes("try 1"))) await new Promise(done => setTimeout(done, 5));
  await outbox.close();
  assert.ok(lines.some(line => line.startsWith("outbox 01a11d25 on mac: m-") && line.includes("try 1: Session worker is failed")), lines.join("\n"));
});
