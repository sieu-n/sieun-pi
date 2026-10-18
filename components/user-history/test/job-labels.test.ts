// Guards the 10-18 loads of chat 01a14d31 from Korea: its children frame was 62 KB of JSON, 56 KB of it the jobs' whole task briefs, and the page got it twice, inline in the shell (126 KB, 33 KB packed) and again on the socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_CHARS, wireEvent } from "../src/first-page.ts";
import { childName } from "../src/client/children.ts";
import type { ChildAgent, ThreadEvent } from "../src/shared/types.ts";

const brief = "Owner's words (verbatim): fix the cold load\n" + "context ".repeat(400);
const child = (n: number, label: string): ChildAgent => ({ id: `sub-${n}`, label, status: "running" });

test("the feed sends the first LABEL_CHARS of each job's label, and the page names the job the same", () => {
  const children = [child(1, brief), child(2, "short label")];
  const event: ThreadEvent = { type: "children", children };
  const sent = wireEvent(event);
  assert.ok(sent.type === "children");
  assert.equal(sent.children[0]!.label.length, LABEL_CHARS);
  assert.equal(sent.children[1], children[1]);
  assert.equal(childName(sent.children[0]!), childName(children[0]!));
  assert.ok(JSON.stringify(sent).length * 5 < JSON.stringify(event).length);
  assert.equal(wireEvent(event), sent, "one cut per event, shared by every page");
  assert.equal(children[0]!.label, brief, "the server's own state keeps the whole brief");
});

test("events without long labels go out as they are", () => {
  const event: ThreadEvent = { type: "children", children: [child(1, "a job")] };
  assert.equal(wireEvent(event), event);
  const status: ThreadEvent = { type: "status", connection: "connected" };
  assert.equal(wireEvent(status), status);
});
