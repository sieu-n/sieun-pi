const HEADER = /^\s*\[agent-message from\s+(?:(?:child|parent|sibling|unknown):)?([^\]]+)\]/;
/** The opener `crossHostText` (src/cross-host-message.ts) puts under the daemon's header, which names only the chat service's client. */
const CROSS_HOST = /^\s*\[cross-host message from (.+?) \([\w-]+\) on [^;\]]+;[^\]]*\]/;
/**
 * Who sent an agent message and its body after the openers: the name an `[agent-message from <relationship>:<name>]` header gives, without
 * the relationship Prime puts first (child, parent, sibling or unknown), or for a root on another box the name its `[cross-host message from
 * <name> (<session id>) on <host>; ...]` line gives, since the daemon heads that one with the chat service's client. vent 10-21: its root
 * "search flows finish" sent its p7 reports at 08:32:59Z and 08:35Z as a sibling, only `child:` was cut, and the check-in read the job silent
 * for 14 h.
 */
export function agentMessageHead(text: string): { name: string; body: string } | undefined {
  const header = HEADER.exec(text);
  if (!header) return undefined;
  const rest = text.slice(header[0].length);
  const cross = CROSS_HOST.exec(rest);
  return cross ? { name: cross[1]!.trim(), body: rest.slice(cross[0].length) } : { name: header[1]!.trim(), body: rest };
}
/** The job or thread name an agent message comes from (`agentMessageHead`). */
export const agentMessageSender = (text: string): string | undefined => agentMessageHead(text)?.name;

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
