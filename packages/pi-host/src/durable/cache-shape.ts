/**
 * A thread's requests, shaped so Anthropic's prompt cache charges for each prefix once.
 *
 * 1. Fold. pi-durable appends a `pi.system` entry each time a section or a tool's text changes (`planSystemEntries`), and the transcript
 *    keeps every one, so a long-lived thread carries each old copy of a changed section and of all its tools. On 11-21 comm thread
 *    5d50e997 held about 600k characters of such updates beside 102k of its first prompt, and an owner turn after the cache lapsed
 *    wrote 268k tokens. Once no request has run for COLD_MS the cache is gone and the next request writes its whole prefix anyway, so
 *    every system message before that point folds into the leading one, which then holds the current sections and tools. A later request
 *    finds the same point from the assistant timestamps, so its prefix stays the same and reads the cache.
 * 2. Breakpoint. pi-ai puts the conversation's cache breakpoint on the last block of the last message. When that message is a system update
 *    whose tools changed, the block is a `tool_addition` or `tool_removal`, and Anthropic writes no cache there: on 11-21, 84 of 125
 *    requests right after such an update sent their history as fresh input (5d50e997's entries 222, 299, 308 and 332, each 160k to 274k
 *    tokens), and the next request wrote it again. So the breakpoint moves to the last block before it that Anthropic caches.
 */
import { getCurrentSystemMessage, type Message, type Provider } from "@earendil-works/pi-ai";

/** A request this long after the one before finds the 1 h cache gone: an hour plus five minutes, as a request's timestamp is its start. */
export const COLD_MS = 65 * 60_000;

/**
 * The index before which system messages fold: the newest assistant message that followed the one before it by COLD_MS or more, or the
 * end of the transcript when this request comes COLD_MS or more after the newest assistant message; 0 when there is none.
 */
export function foldPoint(messages: readonly Message[], now: number): number {
  let point = 0;
  let last: number | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    if (last !== undefined && message.timestamp - last >= COLD_MS) point = index;
    last = message.timestamp;
  });
  if (last !== undefined && now - last >= COLD_MS) point = messages.length;
  return point;
}

/** The transcript with every system message before `foldPoint` folded into the leading one; the same array when nothing folds. */
export function foldSystem(messages: readonly Message[], now: number): readonly Message[] {
  const head = messages[0];
  if (head?.role !== "system") return messages;
  const point = foldPoint(messages, now);
  const folded = messages.slice(1, point).filter(message => message.role === "system");
  if (folded.length === 0) return messages;
  const lead = getCurrentSystemMessage([head, ...folded]);
  const rest = messages.slice(1).filter((message, index) => index + 1 >= point || message.role !== "system");
  return lead ? [lead, ...rest] : rest;
}

type Block = { type?: string; cache_control?: unknown };
type WireMessage = { role?: string; content?: unknown };
const TOOL_CHANGES = new Set(["tool_addition", "tool_removal"]);
const CACHED = new Set(["text", "image", "document", "tool_result", "tool_use"]);

/**
 * Moves each cache breakpoint that sits on a tool change block of an Anthropic request to the nearest block before it that Anthropic
 * caches, in the same message or an earlier one. Returns the payload, changed in place, or undefined when it has no such breakpoint.
 */
export function cacheableBreakpoints(payload: unknown): unknown {
  const messages = (payload as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  const blocks: Block[] = (messages as WireMessage[]).flatMap(message => Array.isArray(message?.content) ? message.content as Block[] : []);
  let moved = false;
  blocks.forEach((block, index) => {
    if (!block?.cache_control || !TOOL_CHANGES.has(block.type ?? "")) return;
    const control = block.cache_control;
    delete block.cache_control;
    moved = true;
    for (let at = index - 1; at >= 0; at--) {
      const before = blocks[at]!;
      if (!CACHED.has(before.type ?? "")) continue;
      before.cache_control ??= control;
      return;
    }
  });
  return moved ? payload : undefined;
}

type StreamOptions = { onPayload?: (payload: unknown, model: never) => unknown } | undefined;

/** `inner` with each request's transcript folded and its breakpoints on cacheable blocks; `now` is the clock the fold reads. */
export function withCacheShape(inner: Provider, now: () => number = Date.now): Provider {
  const shape = <O extends StreamOptions>(context: { messages: Message[] }, options: O): [{ messages: Message[] }, O] => {
    const messages = foldSystem(context.messages, now());
    const own = options?.onPayload;
    const onPayload = async (payload: unknown, model: never): Promise<unknown> => {
      const next = (await own?.(payload, model)) ?? undefined;
      return cacheableBreakpoints(next ?? payload) ?? next;
    };
    return [messages === context.messages ? context : { ...context, messages: [...messages] }, { ...options, onPayload } as O];
  };
  return {
    ...inner,
    stream: (model, context, options) => {
      const [shaped, opts] = shape(context, options as StreamOptions);
      return inner.stream(model, shaped as typeof context, opts as typeof options);
    },
    streamSimple: (model, context, options) => {
      const [shaped, opts] = shape(context, options as StreamOptions);
      return inner.streamSimple(model, shaped as typeof context, opts as typeof options);
    },
  };
}
