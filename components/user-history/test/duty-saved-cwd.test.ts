// Guards the 10-23 and 10-24 duty runs on us-metal02. After the 10-22 move, Crawler VP (01a115e2) held
// /Users/sieunpark/Documents/Github/auto-sns-agent in its session header while its live worker still ran in /home/sieun, the folder the
// daemon lists for it, and its check-ins and alert triages such as "alert triage Crawler VP 11:25" started in /home/sieun.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost, savedChat } from "../src/chat-duty-job.ts";
import type { SessionRow } from "../src/shared/types.ts";

test("a duty run starts in the folder saved in the chat's header, not the folder its live worker runs in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-saved-cwd-"));
  try {
    const file = join(dir, "chat.jsonl");
    await writeFile(file, [
      { type: "session", version: 3, id: "01a115e2-9544-7204-b8db-8ce4d5319048", timestamp: "2026-10-10T00:00:00.000Z", cwd: "/repo/auto-sns-agent" },
      { type: "session_info", id: "a1", parentId: null, timestamp: "2026-10-10T00:00:00.000Z", name: "Crawler VP" },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const listed = { id: "01a115e2-9544-7204-b8db-8ce4d5319048", name: "Crawler VP", cwd: "/home/sieun" } as SessionRow;
    const created: { cwd: string; name: string }[] = [];
    const host = dutyJobHost({
      threads: { create: async input => { created.push(input); return { id: "01a16bba-2893-7000-8000-000000000000" }; }, prompt: async () => {} },
      archives: { add: async () => {} }, rows: async () => [listed],
      registry: { add: async () => {}, chatOf: async () => undefined, chatIdOf: async () => undefined, rootsOf: async () => [], remove: async () => {} },
      board: id => join(dir, `${id}.json`), saved: async () => savedChat(file) });
    const chat = await host.chat(listed.id);
    assert.equal(chat?.cwd, "/repo/auto-sns-agent");
    await host.start(chat!, "alert triage Crawler VP 11:25", "brief");
    assert.deepEqual(created.map(each => each.cwd), ["/repo/auto-sns-agent"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
