import assert from "node:assert/strict";
import { test } from "node:test";
import { createdSessions } from "../src/client/children.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const result = (text: string, toolName = "ipython"): ThreadMessage => ({ role: "toolResult", toolCallId: "t", toolName, content: [{ type: "text", text }], isError: false, timestamp: 1 });
const handle = (id: string, name: string) =>
  `RLMCreateSessionHandle(active_session_id='26df3f799f63', session_id='${id}', name='${name}', session_file=PosixPath('/x/${id}.jsonl'), model='anthropic/claude-fable-5-1')\n`;

test("created sessions come from create_session handles in tool results, once per id, in first-seen order", () => {
  const messages: ThreadMessage[] = [
    { role: "user", content: "start two", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "RLMCreateSessionHandle(active_session_id='x', session_id='not-a-result', name='no'" }], provider: "p", model: "m", stopReason: "stop", timestamp: 0 },
    result(handle("01a1-one", "md-count")),
    result("ok\n" + handle("01a1-two", "seo-todo-count") + handle("01a1-one", "md-count")),
    result("RLMCreateSessionHandle(active_session_id='z', session_id='01a1-three', name=None, session_file=PosixPath('/x'))"),
    result("('10:21', 'toolResult', \"RLMCreateSessionHandle(active_session_id=\\'1\\', session_id=\\'01a1-quoted\\', name=\\'nested\\'\")"),
  ];
  assert.deepEqual(createdSessions(messages), [
    { sessionId: "01a1-one", name: "md-count" },
    { sessionId: "01a1-two", name: "seo-todo-count" },
    { sessionId: "01a1-three", name: "" },
  ]);
  assert.deepEqual(createdSessions([]), []);
});
