import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SKILLS_DIR } from "../index.ts";

const STUB = `
calls = []
emitted = []
async def host_request(kind, payload=None):
    calls.append([kind, payload])
    return {"deliveryStatus": "queued", "id": "agentmsg_x"}
def emit(data):
    emitted.append(data)
`;

const SCRIPT = `
import asyncio, json, rlm, agent_message, agent_observe
async def main():
    await agent_message.send("hi", receiver_role="parent")
    await agent_message.send("go", receiver_role="child", receiver_name="w", mode="follow_up")
    await agent_message.send("all", "everyone")
    await agent_observe.list_agents()
    await agent_observe.get_agent("w")
    await agent_observe.recent_messages("w", limit=3, max_chars=100)
    errors = []
    for kwargs in [dict(receiver_role="child", receiver_name="w", mode="later"), dict(receiver_role="parent", receiver_name="p")]:
        try:
            await agent_message.send("x", **kwargs)
        except (ValueError, TypeError) as e:
            errors.append(str(e))
    print(json.dumps({"calls": rlm.calls, "emitted": len(rlm.emitted), "errors": errors}))
asyncio.run(main())
`;

test("the Python skills keep Prime's names and payloads and add only the optional mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-py-"));
  try {
    writeFileSync(join(dir, "rlm.py"), STUB);
    const path = [dir, join(SKILLS_DIR, "agent-message", "src"), join(SKILLS_DIR, "agent-observe", "src")].join(":");
    const out = JSON.parse(execFileSync("python3", ["-c", SCRIPT], { env: { ...process.env, PYTHONPATH: path }, encoding: "utf8" }));
    assert.deepEqual(out.calls, [
      ["agent_message.send", { message: "hi", receiver_role: "parent", receiver_name: null }],
      ["agent_message.send", { message: "go", receiver_role: "child", receiver_name: "w", mode: "follow_up" }],
      ["agent_message.send", { target: "all", message: "everyone" }],
      ["agent_observe.list", null],
      ["agent_observe.get", { target: "w" }],
      ["agent_observe.recent", { target: "w", limit: 3, max_chars: 100 }],
    ]);
    assert.equal(out.emitted, 3);
    assert.match(out.errors[0], /mode must be/);
    assert.match(out.errors[1], /receiver_name must be omitted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
