import { SessionManager } from "prime-agent";
import { assistant, markedText, text, user } from "./fixtures.ts";

export function populateHistory(manager: SessionManager): void {
  const first = manager.appendMessage(user("FIRST SAVED QUESTION\n\n## Before compaction\n\nA multiline **question**."));
  manager.appendMessage(assistant([markedText("FORBIDDEN COMMENTARY", "commentary"), markedText("FIRST FINAL")]));
  manager.appendCompaction("FORBIDDEN COMPACTION SUMMARY", first, 20000);
  manager.appendMessage(user([
    text('Text before skill'),
    text('<skill name="synthetic" location="/synthetic/SKILL.md">\n## Injected instructions\n\nRead **these instructions**.\n</skill>\n\nApply to the synthetic example.'),
    { type: "image", mimeType: "image/png", data: "FORBIDDEN IMAGE BYTES" },
    text('Text after image'),
  ]));
  manager.appendMessage(assistant([markedText("EARLIER MARKED FINAL")]));
  manager.appendMessage(assistant([markedText("LATEST MARKED FINAL")]));
  manager.appendCustomMessageEntry("agent_message", "FORBIDDEN AGENT MESSAGE", true);
  manager.appendCustomMessageEntry("async_bash_completion", "FORBIDDEN SHELL NOTICE", true);
  manager.appendMessage(user('Hostile input\n\n<script>globalThis.HISTORY_ATTACK=1</script>\n\n[link](javascript:alert%281%29)\n\n![remote image](https://example.invalid/image.png)'));
  manager.appendMessage(assistant([text("UNMARKED SAVED REPLY")], { api: "anthropic-messages" }));
  for (let i = 0; i < 60; i++) {
    manager.appendMessage(user(`Saved question ${i}\n\n${"Long multiline paragraph. ".repeat(30)}`));
    manager.appendMessage(assistant([markedText(`Recorded final ${i}`)]));
  }
  const branchPoint = manager.getLeafId();
  if (!branchPoint) throw new Error("Fixture branch point missing");
  manager.appendMessage(user("FORBIDDEN INACTIVE QUESTION"));
  manager.appendMessage(assistant([markedText("FORBIDDEN INACTIVE FINAL")]));
  manager.branch(branchPoint);
  manager.appendMessage(user("LAST SAVED QUESTION"));
  manager.appendMessage(assistant([markedText("FORBIDDEN PARTIAL FINAL")], { stopReason: "aborted" }));
}
