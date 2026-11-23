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
 * 3. Lean history. A comm thread's turns before that point lose their thinking and long tool texts (`leanHistory`, comm threads only).
 * 4. Images. An image part whose bytes are no type Anthropic takes goes out as a text line (`viewableImages`).
 * 5. Encode. The payload the SDK encodes holds no frozen array, which would push V8's JSON.stringify off its fast path (`thawArrays`).
 */
import { getCurrentSystemMessage, type Message, type Provider } from "@earendil-works/pi-ai";

type ImagePart = { type: "image"; data: string; mimeType: string };

/** The image type an image's first bytes show, of the four Anthropic takes, or undefined for anything else. */
export function sniffImage(data: string): string | undefined {
  const bytes = Buffer.from(data.slice(0, 24), "base64");
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/**
 * An image part as a model can take it: the same part when its bytes are the type it names, the part relabelled when its bytes are
 * another type Anthropic takes, else a text line. On 11-22 the owner's TIFF screenshot in comm thread 5d50e997 made Anthropic answer
 * every turn with 400 "media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'". The result reads only the
 * stored part, so each request sends the same bytes for it and the cache prefix holds.
 */
function viewable<P extends { type: string }>(part: P): P | ImagePart | { type: "text"; text: string } {
  if (part.type !== "image") return part;
  const image = part as unknown as ImagePart;
  const seen = typeof image.data === "string" ? sniffImage(image.data) : undefined;
  if (seen === image.mimeType) return part;
  if (seen) return { ...image, mimeType: seen };
  return { type: "text", text: `[an image of type ${image.mimeType || "unknown"}, not shown]` };
}

/** The transcript with each image part `viewable`; the same array, and the same messages, when every image already is. */
export function viewableImages(messages: readonly Message[]): readonly Message[] {
  let changed = false;
  const out = messages.map((message): Message => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
    const content = (message.content as { type: string }[]).map(viewable);
    if (content.every((part, at) => part === (message.content as unknown[])[at])) return message;
    changed = true;
    return { ...message, content } as Message;
  });
  return changed ? out : messages;
}

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

/** A tool result's text, or a string argument of a tool call, longer than this is cut in the part of a comm thread's history `leanHistory` trims. */
export const LEAN_CHARS = 1500;

const cut = (value: string): string => value.length > LEAN_CHARS ? `${value.slice(0, LEAN_CHARS)}\n[... ${value.length - LEAN_CHARS} more characters cut from an earlier turn]` : value;
const cutArgs = (value: unknown): unknown =>
  typeof value === "string" ? cut(value)
    : Array.isArray(value) ? value.map(cutArgs)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutArgs(item)])) : value;

/**
 * A comm thread's transcript with its earlier turns trimmed, the turns before the one `foldPoint` falls in: each assistant message loses its
 * thinking, a tool call's long string arguments and a tool result's long texts are cut to LEAN_CHARS, and a tool result's image becomes a
 * line. The trimmed part sits before the point where the cache lapsed, so the request that trims it writes its prefix anyway, and later
 * requests trim the same part the same way and read the cache. A comm thread answers in its room and hands work to its work thread, so an
 * old search result or hand-over script does nothing for its next post: on 11-22 its earlier turns' thinking, tool results and tool calls
 * were 1.08M, 0.93M and 0.48M of the 3.0M characters of real comm threads' histories, and cold comm turns cost $1.16 on average.
 * The turn the point falls in stays whole, since Anthropic needs a running tool loop's thinking. Of the earlier turns, only the newest that fit
 * KEEP_CHARS stay (`keepRecent`).
 */
export function leanHistory(messages: readonly Message[], now: number): readonly Message[] {
  const point = foldPoint(messages, now);
  let start = -1;
  for (let index = Math.min(point, messages.length) - 1; index >= 0; index--) {
    if (messages[index]!.role === "user") { start = index; break; }
  }
  if (start <= 0) return messages;
  let changed = false;
  const out = messages.map((message, index): Message => {
    if (index >= start) return message;
    if (message.role === "assistant") {
      const content: typeof message.content = message.content.flatMap((part): typeof message.content =>
        part.type === "thinking" ? [] : part.type === "toolCall" ? [{ ...part, arguments: cutArgs(part.arguments) as typeof part.arguments }] : [part]);
      if (content.length === 0) return message;
      if (JSON.stringify(content) === JSON.stringify(message.content)) return message;
      changed = true;
      return { ...message, content };
    }
    if (message.role === "toolResult") {
      const content: typeof message.content = message.content.map(part =>
        part.type === "text" ? (part.text.length > LEAN_CHARS ? { ...part, text: cut(part.text) } : part) : { type: "text" as const, text: "[an image from an earlier turn]" });
      if (content.every((part, at) => part === message.content[at])) return message;
      changed = true;
      return { ...message, content };
    }
    return message;
  });
  return keepRecent(changed ? out : messages, start);
}

/**
 * About how much of a comm thread's earlier turns a cold request keeps, in characters of their messages after the trim, about 17k tokens.
 * On 11-22 cold comm turns that kept every earlier turn wrote 51k to 239k tokens at $8/M and cost $1.52 on average over 6 turns, almost all
 * of it that one cache write, and the biggest threads keep growing until they compact at 483,616 tokens.
 */
export const KEEP_CHARS = 60_000;
export const LEFT_OUT_NOTE = "[Earlier turns of this thread are left out of this request. Read them with search_history, the room's posts, " +
  "or agent_observe on your work thread when you need one.]";

const sizeOf = (message: Message): number => message.role === "system" ? 0 : JSON.stringify(message.content).length;

/**
 * `messages` without the earlier turns before `start` that do not fit KEEP_CHARS, newest kept first and cut only where a turn starts, so a tool
 * call keeps its result. System messages stay in place, since the fold reads them. The first kept turn's input opens with LEFT_OUT_NOTE.
 */
function keepRecent(messages: readonly Message[], start: number): readonly Message[] {
  let size = 0;
  let from = start;
  for (let index = start - 1; index >= 1; index--) {
    size += sizeOf(messages[index]!);
    if (size > KEEP_CHARS) break;
    if (messages[index]!.role === "user") from = index;
  }
  const dropped = messages.slice(1, from).some(message => message.role !== "system");
  if (!dropped) return messages;
  return messages.flatMap((message, index): Message[] => {
    if (index === 0 || message.role === "system" || index > from) return [message];
    if (index < from) return [];
    const user = message as Extract<Message, { role: "user" }>;
    const content = typeof user.content === "string" ? [{ type: "text" as const, text: user.content }] : user.content;
    return [{ ...user, content: [{ type: "text" as const, text: LEFT_OUT_NOTE }, ...content] }];
  });
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

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * `value` with every frozen array in it copied, sharing every other node, or `value` itself when it holds none. The copy is an unfrozen array
 * with the same items, and each plain object on the way to one is a spread with the same keys in the same order, so JSON.stringify writes the same
 * bytes. V8's JSON.stringify leaves its fast path at a frozen array, and the later in the body it meets one, the more it pays: on a copy rig on 11-23,
 * the Anthropic SDK's encode of an 8.8 MB request took 113 to 148 ms with the frozen `required` arrays of pi-durable's frozen tool schemas in
 * `tools`, which follow the messages, and 26 to 36 ms with those arrays copied (~/work/pi-host-stalls/m-request-cpu/report.md).
 */
export function thawArrays<T>(value: T): T {
  if (Array.isArray(value)) {
    let out: unknown[] = Object.isFrozen(value) ? value.slice() : value;
    value.forEach((item: unknown, index: number) => {
      const next = thawArrays(item);
      if (next === item) return;
      if (out === value) out = value.slice();
      out[index] = next;
    });
    return out as T;
  }
  if (value === null || typeof value !== "object" || !isPlainObject(value)) return value;
  let out: Record<string, unknown> = value;
  for (const key of Object.keys(value)) {
    const item = value[key];
    const next = thawArrays(item);
    if (next === item) continue;
    if (out === value) out = { ...value };
    out[key] = next;
  }
  return out as T;
}

type StreamOptions = { onPayload?: (payload: unknown, model: never) => unknown } | undefined;

/** `inner` with each request's images viewable, its transcript folded and its breakpoints on cacheable blocks; `now` is the clock the fold reads. */
export function withCacheShape(inner: Provider, now: () => number = Date.now): Provider {
  const shape = <O extends StreamOptions>(context: { messages: Message[] }, options: O): [{ messages: Message[] }, O] => {
    const messages = foldSystem(viewableImages(context.messages), now());
    const own = options?.onPayload;
    const onPayload = async (payload: unknown, model: never): Promise<unknown> => {
      const next = (await own?.(payload, model)) ?? undefined;
      const shaped = cacheableBreakpoints(next ?? payload) ?? next;
      const sent = shaped ?? payload;
      const thawed = thawArrays(sent);
      return thawed === sent ? shaped : thawed;
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
