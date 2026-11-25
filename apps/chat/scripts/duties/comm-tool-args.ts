/**
 * The args of each comm tool as pi-host gives it to a thread: the tool definitions built by their own factories, plus Prime's chat_board as
 * the user-history extension registers it. Duty d6 (`docs-current.ts`) compares them with the Args table of each reference page, so a page
 * that leaves out an arg or names one the code dropped reads as a mismatch. Building a definition calls nothing: the ChatApp is never used.
 *
 * Usage, from packages/pi-host of the sieun-pi checkout: node --import tsx ../../apps/chat/scripts/duties/comm-tool-args.ts
 * It prints `{"<tool>": {"<arg>": true when required}}` as JSON.
 */
import { ChatApp } from "../../../../packages/pi-host/src/durable/chat-app.ts";
import { commExtension, type CommHost } from "../../../../packages/pi-host/src/durable/comm.ts";
import { forMeTools } from "../../../../packages/pi-host/src/durable/for-me.ts";
import { laterTools } from "../../../../packages/pi-host/src/durable/later.ts";
import { loadPiExtension } from "../../../../packages/pi-host/src/durable/pi-extensions.ts";
import { readPostTools } from "../../../../packages/pi-host/src/durable/read-post.ts";
import { roomMemberTools } from "../../../../packages/pi-host/src/durable/room-members.ts";
import { ROOM_TELL_OWNER_PARAMETERS } from "../../../../packages/pi-host/src/durable/room-post.ts";
import { roomTools } from "../../../../packages/pi-host/src/durable/room-tools.ts";
import { searchTools } from "../../../../packages/pi-host/src/durable/search-messages.ts";
import { SendMessage } from "../../../../packages/pi-host/src/durable/send-message.ts";

export type ToolArgs = Record<string, Record<string, boolean>>;

interface Schema { properties?: Record<string, unknown>; required?: readonly string[] }
interface Named { name: string; parameters: unknown }

const argsOf = (schema: unknown): Record<string, boolean> => {
  const { properties = {}, required = [] } = (schema ?? {}) as Schema;
  return Object.fromEntries(Object.keys(properties).map(name => [name, required.includes(name)]));
};

const toolsOf = (extension: unknown): Named[] => ((extension as { tools?: Named[] }).tools ?? []);

/** Every comm tool's args, by tool name. */
export async function commToolArgs(): Promise<ToolArgs> {
  const app = new ChatApp();
  const thread = "comm-tool-args";
  const tools: Named[] = [
    ...toolsOf(SendMessage),
    ...toolsOf(roomTools(app, thread)),
    ...toolsOf(commExtension({} as CommHost).extension),
    ...forMeTools(app, thread), ...laterTools(app, thread), ...readPostTools(app, thread), ...searchTools(app), ...roomMemberTools(app, thread),
    { name: "tell_owner", parameters: ROOM_TELL_OWNER_PARAMETERS },
  ];
  const prime = await loadPiExtension((await import("../../../../legacy/prime/user-history/extension/index.ts")).default as (pi: never) => unknown, {
    flags: { chat: true, "owner-thread": true },
  });
  const board = prime.tools.get("chat_board");
  if (board) tools.push(board as Named);
  return Object.fromEntries(tools.map(tool => [tool.name, argsOf(tool.parameters)]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await commToolArgs()));
  process.exit(0);
}
