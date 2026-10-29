/**
 * The `durable_*` socket commands: the chat's view of durable threads. They sit beside the v7 subset on the same
 * socket, and a watch sends `durable_event` lines to the connection that asked until `durable_unwatch` or disconnect.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef, SubmissionId } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { fail, ok, type Response } from "../protocol.ts";
import type { Sink } from "../session.ts";
import { FeedStreams } from "./feed.ts";
import type { DurableThreads, SubmitInput } from "./threads.ts";

export const DURABLE_COMMANDS = new Set([
  "durable_threads", "durable_create", "durable_submit", "durable_wait", "durable_watch", "durable_unwatch", "durable_abort", "durable_tree",
  "durable_entries", "durable_search", "durable_usage", "durable_doc_get", "durable_doc_put", "durable_set", "durable_import", "durable_ticket",
  "durable_feed", "durable_feed_stop", "durable_feed_read",
]);

type Command = { id?: string; type: string; [key: string]: unknown };

function modelRef(value: unknown): ModelRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && typeof (value as ModelRef).provider === "string" && typeof (value as ModelRef).modelId === "string") return value as ModelRef;
  if (typeof value !== "string" || !value.includes("/")) throw new Error(`model must be "provider/id" or {provider, modelId}, got ${JSON.stringify(value)}`);
  const [provider, ...rest] = value.split("/");
  return { provider: provider!, modelId: rest.join("/") };
}

const str = (command: Command, key: string): string => {
  const value = command[key];
  if (typeof value !== "string" || !value) throw new Error(`${command.type} needs ${key}`);
  return value;
};
const optStr = (command: Command, key: string): string | undefined => (typeof command[key] === "string" ? (command[key] as string) : undefined);
const optNum = (command: Command, key: string): number | undefined => (typeof command[key] === "number" ? (command[key] as number) : undefined);
const strs = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every(v => typeof v === "string") ? (value as string[]) : undefined);
/** `by` of durable_search: the agent's thread and conversation, and the id it sends agent messages as. */
function byOf(value: unknown): { thread: string; conversation: number; id: string } {
  const by = (value ?? {}) as { thread?: unknown; conversation?: unknown; id?: unknown };
  if (typeof by.thread !== "string" || typeof by.conversation !== "number" || typeof by.id !== "string") throw new Error(`by must be {thread, conversation, id}, got ${JSON.stringify(value)}`);
  return { thread: by.thread, conversation: by.conversation, id: by.id };
}

/** `skipEntries` of durable_search: the entries to leave out, each {thread, entry}. */
function skipEntriesOf(value: unknown): { thread: string; entry: number }[] {
  const list = Array.isArray(value) ? (value as { thread?: unknown; entry?: unknown }[]) : [];
  if (!Array.isArray(value) || list.some(e => typeof e?.thread !== "string" || typeof e.entry !== "number")) throw new Error(`skipEntries must be [{thread, entry}], got ${JSON.stringify(value)}`);
  return list.map(e => ({ thread: e.thread as string, entry: e.entry as number }));
}

export class DurableCommands {
  /** Watches by connection, so a closed socket stops its streams. */
  private readonly watches = new Map<string, Map<string, () => Promise<void>>>();

  /** The `durable_feed` streams over the host's outbox, by connection. */
  private readonly feeds: FeedStreams;

  constructor(readonly threads: DurableThreads) {
    this.feeds = new FeedStreams(threads.index);
  }

  handles(type: string): boolean {
    return DURABLE_COMMANDS.has(type);
  }

  /** Answers one command, or undefined when it wrote its own response first, as `durable_feed` does before its backlog rows. */
  async handle(command: Command, sink: Sink): Promise<Response | undefined> {
    const id = command.id;
    const done = (data?: unknown) => ok(id, command.type, data);
    try {
      switch (command.type) {
        case "durable_threads":
          return done({ threads: this.threads.list(typeof command.archived === "boolean" ? { archived: command.archived } : {}) });
        case "durable_create": {
          const model = modelRef(command.model);
          return done({ thread: await this.threads.create({
            ...(optStr(command, "name") ? { name: optStr(command, "name")! } : {}),
            ...(model ? { model } : {}),
            ...(optStr(command, "thinkingLevel") ? { thinkingLevel: optStr(command, "thinkingLevel") as ModelThinkingLevel } : {}),
            ...(optStr(command, "cwd") ? { cwd: optStr(command, "cwd")! } : {}),
          }) });
        }
        case "durable_submit": {
          const input: SubmitInput = {
            ...(optNum(command, "conversation") === undefined ? {} : { conversation: optNum(command, "conversation")! }),
            ...(optStr(command, "text") === undefined ? {} : { text: optStr(command, "text")! }),
            ...(Array.isArray(command.images) ? { images: command.images as SubmitInput["images"] } : {}),
            ...(optStr(command, "requestId") === undefined ? {} : { requestId: optStr(command, "requestId")! }),
            ...(optStr(command, "whenBusy") === undefined ? {} : { whenBusy: optStr(command, "whenBusy") as SubmitInput["whenBusy"] }),
            ...(command.ownerTurn === true ? { ownerTurn: true } : {}),
          };
          const entry = command.entry as { kind?: unknown; data?: { from?: unknown; via?: unknown } } | undefined;
          if (entry !== undefined) {
            if (entry.kind !== "agent.message" || typeof entry.data?.from !== "string") throw new Error('durable_submit entry must be {kind: "agent.message", data: {from, via?}}');
            input.entry = { kind: "agent.message", data: { from: entry.data.from, ...(typeof entry.data.via === "string" ? { via: entry.data.via } : {}) } };
          }
          return done(await this.threads.submit(str(command, "thread"), input));
        }
        case "durable_wait":
          return done({ settled: await this.threads.wait(str(command, "thread"), command.submission as SubmissionId) });
        case "durable_watch": {
          const thread = str(command, "thread");
          const watchId = `durable-watch:${randomUUID()}`;
          const stop = await this.threads.watch(thread, {
            ...(optNum(command, "conversation") === undefined ? {} : { conversation: optNum(command, "conversation")! }),
            ...(optNum(command, "fromEntry") === undefined ? {} : { fromEntry: optNum(command, "fromEntry")! }),
          }, event => sink.write({ type: "durable_event", thread, watch: watchId, event }));
          let mine = this.watches.get(sink.clientId);
          if (!mine) this.watches.set(sink.clientId, (mine = new Map()));
          mine.set(watchId, stop);
          return done({ watch: watchId });
        }
        case "durable_unwatch": {
          const watchId = str(command, "watch");
          const stop = this.watches.get(sink.clientId)?.get(watchId);
          this.watches.get(sink.clientId)?.delete(watchId);
          await stop?.();
          return done({ stopped: stop !== undefined });
        }
        case "durable_feed": {
          const after = optNum(command, "after") ?? 0;
          const feed = `durable-feed:${randomUUID()}`;
          sink.write(done({ feed }));
          this.feeds.open(sink, feed, after);
          return undefined;
        }
        case "durable_feed_stop":
          return done({ stopped: this.feeds.stop(sink.clientId, str(command, "feed")) });
        case "durable_feed_read": {
          const limit = optNum(command, "limit");
          return done(this.threads.index.readOutbox(optNum(command, "after") ?? 0, limit === undefined ? undefined : Math.max(1, Math.floor(limit))));
        }
        case "durable_abort":
          await this.threads.abort(str(command, "thread"), optNum(command, "conversation"));
          return done();
        case "durable_ticket":
          return done({ ticket: (await this.threads.ticket(str(command, "thread"), optNum(command, "conversation"))) ?? null });
        case "durable_tree":
          return done({ conversations: await this.threads.tree(str(command, "thread")) });
        case "durable_entries":
          return done(await this.threads.entries(str(command, "thread"), {
            ...(optNum(command, "conversation") === undefined ? {} : { conversation: optNum(command, "conversation")! }),
            ...(optNum(command, "before") === undefined ? {} : { before: optNum(command, "before")! }),
            ...(optNum(command, "after") === undefined ? {} : { after: optNum(command, "after")! }),
            ...(optNum(command, "limit") === undefined ? {} : { limit: optNum(command, "limit")! }),
          }));
        case "durable_search":
          return done(this.threads.search({
            q: str(command, "q"),
            ...(Array.isArray(command.threads) ? { threads: command.threads as string[] } : {}),
            ...(optNum(command, "conversation") === undefined ? {} : { conversation: optNum(command, "conversation")! }),
            ...(optStr(command, "from") === undefined ? {} : { from: optStr(command, "from")! }),
            ...(command.by === undefined ? {} : { by: byOf(command.by) }),
            ...(optStr(command, "skipAgentMessages") === undefined ? {} : { skipAgentMessages: optStr(command, "skipAgentMessages")! }),
            ...(optStr(command, "notFrom") === undefined ? {} : { notFrom: optStr(command, "notFrom")! }),
            ...(strs(command.kinds) ? { kinds: strs(command.kinds)! } : {}),
            ...(strs(command.skipKinds) ? { skipKinds: strs(command.skipKinds)! } : {}),
            ...(command.skipEntries === undefined ? {} : { skipEntries: skipEntriesOf(command.skipEntries) }),
            ...(strs(command.demoteKinds) ? { demoteKinds: strs(command.demoteKinds)! } : {}),
            ...(optNum(command, "after") === undefined ? {} : { after: optNum(command, "after")! }),
            ...(optNum(command, "before") === undefined ? {} : { before: optNum(command, "before")! }),
            ...(optNum(command, "limit") === undefined ? {} : { limit: optNum(command, "limit")! }),
            ...(optNum(command, "offset") === undefined ? {} : { offset: optNum(command, "offset")! }),
            ...(command.sort === "recent" || command.sort === "relevance" ? { sort: command.sort } : {}),
          }));
        case "durable_usage":
          return done({ usage: this.threads.usage({
            ...(optNum(command, "since") === undefined ? {} : { since: optNum(command, "since")! }),
            ...(optNum(command, "until") === undefined ? {} : { until: optNum(command, "until")! }),
            ...(Array.isArray(command.threads) ? { threads: command.threads as string[] } : {}),
          }) });
        case "durable_doc_get":
          return done({ value: await this.threads.docGet(str(command, "thread"), str(command, "name"), optNum(command, "conversation")) });
        case "durable_doc_put":
          await this.threads.docPut(str(command, "thread"), str(command, "name"), command.value ?? null, optNum(command, "conversation"));
          return done();
        case "durable_set": {
          const model = modelRef(command.model);
          return done({ thread: await this.threads.set(str(command, "thread"), {
            ...(optStr(command, "name") === undefined ? {} : { name: optStr(command, "name")! }),
            ...(model ? { model } : {}),
            ...(optStr(command, "thinkingLevel") ? { thinkingLevel: optStr(command, "thinkingLevel") as ModelThinkingLevel } : {}),
            ...(typeof command.archived === "boolean" ? { archived: command.archived } : {}),
            ...(optStr(command, "cwd") === undefined ? {} : { cwd: optStr(command, "cwd")! }),
          }) });
        }
        case "durable_import": {
          const model = modelRef(command.model);
          return done({ thread: await this.threads.importSession(str(command, "path"), {
            ...(optStr(command, "name") === undefined ? {} : { name: optStr(command, "name")! }),
            ...(model ? { model } : {}),
            ...(optStr(command, "cwd") === undefined ? {} : { cwd: optStr(command, "cwd")! }),
          }) });
        }
        default:
          return fail(id, command.type, `Unknown durable command: ${command.type}`);
      }
    } catch (error) {
      return fail(id, command.type, error);
    }
  }

  async disconnect(clientId: string): Promise<void> {
    this.feeds.disconnect(clientId);
    const mine = this.watches.get(clientId);
    this.watches.delete(clientId);
    for (const stop of mine?.values() ?? []) await stop().catch(() => undefined);
  }
}
