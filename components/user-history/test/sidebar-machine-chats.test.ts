// Guards the owner's ask of 10-18 ("bring back the Filter UI, and View edit UI. in View UI have Chat only view, filter allow by machine easily") after 87d692e cut the sidebar filter and views.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyRowFilter, machinesOf, matchesRowFilter, sidebarSections } from "../src/client/organize.ts";
import type { SessionRow } from "../src/shared/types.ts";

const row = (id: string, extra: Partial<SessionRow>): SessionRow =>
  ({ id, name: id, cwd: "/home/sieun", tags: [], priority: 0, working: false, unread: false, lastActivityAt: "2026-10-18T05:00:00Z", ...extra }) as SessionRow;
const rows = [
  row("chat-mac", { chat: true, host: "mac" }),
  row("chat-metal", { chat: true, host: "us-metal02" }),
  row("thread-metal", { host: "us-metal02" }),
  row("beat-mac", { host: "mac", schedule: { kind: "heartbeat", status: "active" } as NonNullable<SessionRow["schedule"]> }),
];
const ids = (list: readonly SessionRow[]) => list.map(item => item.id);

test("the machine filter keeps only the rows of the picked box, and All keeps every row", () => {
  assert.deepEqual(machinesOf(rows), ["mac", "us-metal02"]);
  assert.deepEqual(ids(rows.filter(item => matchesRowFilter(item, { ...emptyRowFilter(), host: "us-metal02" }))), ["chat-metal", "thread-metal"]);
  assert.equal(rows.filter(item => matchesRowFilter(item, emptyRowFilter())).length, rows.length);
});

test("the Chats only view lists the chats and drops heartbeats and plain threads", () => {
  const all = sidebarSections(rows, "current");
  assert.deepEqual([ids(all.chats).sort(), ids(all.beats), all.groups.flatMap(group => ids(group.rows))], [["chat-mac", "chat-metal"], ["beat-mac"], ["thread-metal"]]);
  const chats = sidebarSections(rows, "chats");
  assert.deepEqual([ids(chats.chats).sort(), chats.beats, chats.groups], [["chat-mac", "chat-metal"], [], []]);
});
