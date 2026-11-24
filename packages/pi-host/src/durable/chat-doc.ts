/**
 * The chat's named JSON documents, kept apart from `registry.ts` so the doc-peek worker (`doc-peek.ts`) loads pi-durable and this alone:
 * with the registry's module graph a worker thread added 142 MB to pi-host's RSS, with this one 52 MB (~/work/pi-host-stalls/q-sqlite-exec/).
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";

/** Named JSON documents the chat keeps per conversation, such as `chat.meta` and `chat.board`. */
export const ChatDoc = defineDocFamily<{ value: JsonValue }, null>({
  kind: "chat.doc",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ value: null }),
  checkpointWhen: () => true,
});
