import { type Host, readHostFile } from "./hosts.ts";
import { captureFile, parseCapture, type PromptCapture } from "./prompt-capture.ts";

/**
 * The capture of a session that runs on another box, read through that box's relay (`GET /v1/file`, components/prime-relay). The user-history
 * extension there writes it in the `browser-chat` folder of the agent dir that holds `sessionFile`, the session file's path on that box.
 * Null when the path lies outside an agent dir's `sessions` or `session-artifacts`; a refused or failed read throws.
 */
export async function readHostCapture(host: Host, sessionFile: string, sessionId: string): Promise<PromptCapture | null> {
  const agentDir = /^(.*?)\/(?:sessions|session-artifacts)\//.exec(sessionFile)?.[1];
  if (!agentDir) return null;
  return parseCapture((await readHostFile(host, captureFile(`${agentDir}/browser-chat`, sessionId))).bytes.toString("utf8"), sessionId);
}
