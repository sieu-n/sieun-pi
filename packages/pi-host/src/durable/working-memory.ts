/**
 * An agent's working memory (apps/chat/docs/agent-model.md, "Working memory"): `working-memory.md` in the agent's folder, next to
 * `brief.md`, says what the agent knows now across its rooms. The agent's work thread rewrites it after each of its turns, as its role text
 * says (`workInstructions`), and every thread of the agent reads it in full: the work thread, each comm thread, each root job, and each job
 * inside one of them.
 *
 * It is the `working` section, rendered from the file at each request. pi-durable writes a changed section as a new `pi.system` entry at the
 * end of the context, so a rewrite reaches the work thread and each comm thread at its next request as that one section, and the cached
 * prefix before it holds. A job keeps the text it got at its start (`followsRewrites`).
 * The extension installs last, so the section comes after the other extensions' sections and before pi-durable's `instructions`.
 */
import { readFileSync, statSync } from "node:fs";
import { defineExtension, ROOT_CONVERSATION_ID, section, type Extension } from "@earendil-works/pi-durable";
import { agentName, threadAgent, workingMemoryPath, type AgentRef } from "./agent-profile.ts";

export { workingMemoryPath };

export interface WorkingFile { path: string; text: string; modifiedAt: number }

const files = new Map<string, { stamp: string; file: WorkingFile | undefined }>();

/** The file's text, or undefined when it is missing, unreadable or blank; read again only when the file changed. */
export function readWorkingMemory(ref: Pick<AgentRef, "dir">): WorkingFile | undefined {
  const path = workingMemoryPath(ref);
  const stat = statSync(path, { throwIfNoEntry: false });
  const stamp = stat?.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "none";
  const kept = files.get(path);
  if (kept?.stamp === stamp) return kept.file;
  let text = "";
  try {
    text = stamp === "none" ? "" : readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const file = text.trim() && stat ? { path, text, modifiedAt: stat.mtimeMs } : undefined;
  files.set(path, { stamp, file });
  return file;
}

const minute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/**
 * The section a thread of `agent` reads: what the file is, who writes it, and its whole text, or a line that the file is not written yet.
 * A missing file still gets the section, so writing the file later changes its text and never adds a section before `instructions`, which
 * would have pi-durable send every section again.
 */
export function workingMemoryText(agent: string, path: string, file: WorkingFile | undefined): string {
  if (!file) return `# Working memory\n\nAgent ${agent} has no working memory yet. Its work thread writes it to ${path} after its turns.`;
  return [
    "# Working memory",
    "",
    `Agent ${agent}'s working memory, ${file.path}, last written ${minute(file.modifiedAt)}. It says what the agent knows now across its rooms. ` +
      "Its work thread rewrites it after each of its turns, and no other thread writes it, so send the work thread what changed instead. Step status lives on the board.",
    "",
    "<working_memory>",
    file.text.trimEnd(),
    "</working_memory>",
  ].join("\n");
}

/**
 * Whether a conversation gets each rewrite: only the root of the work thread and of a comm thread. A job, a root job or a conversation inside
 * any thread, keeps the text it got at its start, as Prime pins a job's digest. On 11-23, in the first 28 min after the install, one job of
 * agent factory got 9 copies, 28 KB, while its work thread rewrote the file after each turn (~/work/working-memory/measure-2150.json).
 */
const followsRewrites = (ref: AgentRef, conversation: number): boolean => conversation === ROOT_CONVERSATION_ID && (ref.role === "work" || ref.role === "comm");

/** The extension with the `working` section, for a thread whose root conversation names an agent. */
export function workingMemory(): Extension {
  return defineExtension({
    name: "working-memory",
    sections: [section("working", async (input, context) => {
      const ref = await threadAgent(input.read, context);
      if (!ref) return undefined;
      if (input.shown.working !== undefined && !followsRewrites(ref, input.conversationId)) return input.shown.working;
      return workingMemoryText(agentName(ref), workingMemoryPath(ref), readWorkingMemory(ref));
    }, { tag: false })],
  });
}
