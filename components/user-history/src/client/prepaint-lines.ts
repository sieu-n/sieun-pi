import { render } from "svelte/server";
import ChatLines from "./ChatLines.svelte";
import { mentionIndex } from "./board.ts";
import { FIRST_ITEMS, windowStart } from "./feed-window.ts";
import { jobNames } from "./jobs.ts";
import { chatFeed, turnStarter } from "../shared/chat-feed.ts";
import { isThreadBusy, threadStateFromSnapshot } from "../shared/thread-state.ts";
import type { ThreadEvent } from "../shared/types.ts";

const ignore = (): void => {};
const ignoreAsync = async (): Promise<void> => {};

/**
 * The server half of the client bundle (chat-assets.ts `compileServer`): ChatLines.svelte rendered to HTML from the first page the shell carries,
 * with what Chat.svelte has when that page arrives before the sessions list and the board: no catalog names, no board chips, no page sends.
 * `earlier` is Chat.svelte's `hasEarlier`: the page holds or has more items above the drawn ones. Null when the page has no snapshot or no lines.
 */
export function prepaintLines(id: string, frames: string): { lines: string; title: string; earlier: boolean } | null {
  const events = JSON.parse(frames) as ThreadEvent[];
  const first = events.find(event => event.type === "snapshot");
  if (first?.type !== "snapshot") return null;
  const thread = threadStateFromSnapshot(first.snapshot);
  const feed = chatFeed(thread, [], () => undefined);
  if (!feed.length) return null;
  const start = windowStart(feed.map(item => item.id), null, FIRST_ITEMS);
  const typing = isThreadBusy({ ...thread, children: [] }) && turnStarter(thread.messages) === "owner" && !feed.some(item => item.kind === "agent" && item.streaming);
  const mentions = mentionIndex(id, null, jobNames(undefined, thread, () => undefined));
  const { body } = render(ChatLines, { props: {
    id, feed, start, minute: Math.floor(Date.now() / 60_000) * 60_000, cwd: thread.info.cwd ?? "", mentions, typing,
    reply: ignore, copyLink: ignoreAsync, goToLine: ignoreAsync, viewImage: ignore, seeReply: ignore, press: () => ignore, onProseClick: ignore, readUpdates: ignore,
  } });
  return { lines: body, title: thread.info.name ?? "New chat", earlier: start > 0 || thread.older !== undefined };
}
