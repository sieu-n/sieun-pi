import { type Host, hostFileStamp, readHostFile } from "./hosts.ts";
import { captureFile, parseCapture, type PromptCapture, withoutImageData } from "./prompt-capture.ts";

/**
 * Each capture read from another box, by box and path, with the stamp (size and modified time) it was read at. A capture an older extension
 * wrote holds each image's base64: frontend bro's on the Mac was 5.16 MB on 10-22, read through the relay in 1.0 to 2.2 s on every open of
 * the Prompt dialog, while the HEAD that checks the stamp is one round trip. The kept copy has the image data left out (0.51 MB for that one).
 */
const kept = new Map<string, { stamp: string; capture: PromptCapture | null }>();

/**
 * The capture of a session that runs on another box, read through that box's relay (`GET /v1/file`, components/prime-relay). The user-history
 * extension there writes it in the `browser-chat` folder of the agent dir that holds `sessionFile`, the session file's path on that box.
 * Null when the path lies outside an agent dir's `sessions` or `session-artifacts`; a refused or failed read throws. A capture whose size and
 * modified time match the last read is not read again.
 */
export async function readHostCapture(host: Host, sessionFile: string, sessionId: string): Promise<PromptCapture | null> {
  const agentDir = /^(.*?)\/(?:sessions|session-artifacts)\//.exec(sessionFile)?.[1];
  if (!agentDir) return null;
  const file = captureFile(`${agentDir}/browser-chat`, sessionId);
  const key = `${host.name}:${file}`;
  const stamp = await hostFileStamp(host, file);
  const last = kept.get(key);
  if (last?.stamp === stamp) return last.capture;
  const read = parseCapture((await readHostFile(host, file)).bytes.toString("utf8"), sessionId);
  const capture = read && JSON.parse(JSON.stringify(read, withoutImageData)) as PromptCapture;
  kept.set(key, { stamp, capture });
  return capture;
}
