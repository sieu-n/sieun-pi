// Guards the 10-19 trace gap: a pin of chat 01a15427 to an Off account could not be tied to a caller, so each account action names one.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { accountActionLine } from "../src/chat-server.ts";

const request = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;

test("an account action line names the action, the thread and who asked", () => {
  const use = { action: "use", provider: "anthropic", account: "f49ceee6", id: "01a15427-145f" } as const;
  assert.equal(accountActionLine(use, request({ "x-chat-owner-ui": "1", "user-agent": "Mozilla/5.0" })),
    "accounts: use f49ceee6 (anthropic) on 01a15427-145f by the owner's page from 127.0.0.1 (Mozilla/5.0)");
  assert.match(accountActionLine(use, request({ "x-chat-agent-session": "01a1518f-c209" })), /by agent 01a1518f-c209 from 127\.0\.0\.1 \(-\)$/);
  assert.match(accountActionLine({ action: "follow", provider: "anthropic", id: "01a15427-145f" }, request({ "user-agent": "node" })),
    /^accounts: follow \(anthropic\) on 01a15427-145f by an unnamed caller from 127\.0\.0\.1 \(node\)$/);
});
