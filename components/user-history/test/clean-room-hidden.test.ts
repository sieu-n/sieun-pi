// Guards owner rule c85 (run r3c, 10-18 02:10Z): a clean-room chat showed in the owner's sidebar and For you count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { inSidebar, originOf } from "../src/client/organize.ts";

test("a clean-room test chat is agent-created, so the owner's sidebar and For you count leave it out (r3c, 10-18 02:10Z)", async () => {
  const linkedin = "01a14c62-6999-715e-9a56-31ad0bd5fb59", harness = "01a1164b-4a2d-742d-b27a-82f086ed0200";
  const index = (ids: string[]) => ({ ids: async () => ids });
  // Both chats are in chats.json and threads.json, as POST api/threads files every chat; only the clean-room file tells them apart.
  const origins = new ThreadOrigins(index([linkedin, harness]), index([linkedin]));
  const originOfRow = await origins.resolver(new Set([linkedin, harness]));
  assert.equal(originOfRow({ sessionId: linkedin }), "agent");
  assert.equal(originOfRow({ sessionId: harness }), "user");
  assert.equal((await new ThreadOrigins(index([linkedin])).resolver(new Set([linkedin])))({ sessionId: linkedin }), "user", "with no clean-room index it stays the person's");
  const row = (id: string) => ({ id, origin: originOfRow({ sessionId: id }), archived: false, chat: true } as unknown as Parameters<typeof inSidebar>[0]);
  assert.equal(originOf(row(linkedin)), "agent");
  assert.equal(inSidebar(row(linkedin), { archived: false, agentCreated: false }), false);
  assert.equal(inSidebar(row(harness), { archived: false, agentCreated: false }), true);
});
