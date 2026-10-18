/** The job or thread name an `[agent-message from <name>]` text opens with, without a `child:` prefix. */
export const agentMessageSender = (text: string): string | undefined => /^\s*\[agent-message from\s+(?:child:)?([^\]]+)\]/.exec(text)?.[1]!.trim();

/**
 * Whether the chat already got `line`, a `[job]` notice, with no message from job `name` after it. One job end is one notice, also after a
 * service restart empties the server's memory of told ends (VP of CI 10-13: "[job] repo rules check fix ended at 18:20 with no report" at
 * 09:22Z, the service restarted at 09:25Z, and the same line came again at 09:52Z).
 */
export function noticeStands(messages: readonly { role: string; customType?: string; content?: unknown }[], name: string, line: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
    if (message.role === "user" && text.trim() === line) return true;
    if (message.role === "custom" && message.customType === "agent_message" && agentMessageSender(text) === name) return false;
  }
  return false;
}
