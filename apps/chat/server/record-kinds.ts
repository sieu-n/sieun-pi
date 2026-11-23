/**
 * The JSON files of agents, rooms, the owner's state and the For lists as documents in chat.sqlite (chat-records.ts), and the channel files
 * from before phase 5, which only migrate-channels.ts reads. Each table name starts with its kind's name.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentsFile, RoomsFile } from "./agent-store.ts";
import { docKind, readDoc, type DocSpec } from "./chat-records.ts";
import type { JsonKind } from "./json-move.ts";
import type { StateFile } from "./store.ts";

const field = (name: string) => (value: unknown): string | null => {
  const found = (value as Record<string, unknown> | null)?.[name];
  return typeof found === "string" ? found : null;
};
const id = (item: unknown): string => String((item as { id?: unknown } | null)?.id ?? "");

/** agents.json: each agent, and the thread ids that belong to an agent. */
export const AGENTS: DocSpec<AgentsFile> = {
  kind: "agents",
  file: "agents.json",
  collections: [
    { key: "agents", table: "agents_agents", shape: "list", column: "id", id, columns: { room: field("room"), work_thread: field("workThread") } },
    { key: "aliases", table: "agents_aliases", shape: "map", column: "thread", columns: { agent: value => (typeof value === "string" ? value : null) } },
  ],
  empty: () => ({ v: 1, agents: [], aliases: {} }),
};

/** rooms.json: each room, and the feed cursor of each agent's DM and of each group room's comm thread. */
export const ROOMS: DocSpec<RoomsFile> = {
  kind: "rooms",
  file: "rooms.json",
  collections: [
    { key: "rooms", table: "rooms_rooms", shape: "list", column: "id", id, columns: { kind: field("kind") } },
    { key: "feed", table: "rooms_feed", shape: "map", column: "agent" },
    { key: "commFeed", table: "rooms_comm_feed", shape: "map", column: "thread" },
  ],
  empty: () => ({ v: 1, rooms: [], feed: {} }),
};

/** state.json: thread kinds, read marks, archived jobs and the sidebar prefs by conversation; the layout and owner settings stay whole. */
export const STATE: DocSpec<StateFile> = {
  kind: "state",
  file: "state.json",
  collections: [
    { key: "threads", table: "state_threads", shape: "map", column: "thread" },
    { key: "reads", table: "state_reads", shape: "map", column: "conversation" },
    { key: "archivedJobs", table: "state_archived_jobs", shape: "map", column: "conversation" },
    { key: "sidebar", table: "state_sidebar", shape: "map", column: "conversation" },
  ],
  empty: () => ({ v: 1, threads: {}, reads: {} }),
};

/** for-me.json: each agent's completed marks by item; `since` stays with the document. */
export interface ForMeFile { v: 1; since: number; marks: Record<string, Record<string, { completed: boolean; at: number }>> }
export const FOR_ME: DocSpec<ForMeFile> = {
  kind: "for_me",
  file: "for-me.json",
  collections: [{ key: "marks", table: "for_me_marks", shape: "map2", column: "agent", inner: "item" }],
  empty: () => ({ v: 1, since: Date.now(), marks: {} }),
  syncJson: true,
};

/** channels.json of before phase 5: each channel, which migrate-channels.ts read into rooms on 10-29. */
const CHANNEL_LIST: DocSpec<{ channels: unknown[] }> = {
  kind: "channels",
  file: "channels.json",
  collections: [{ key: "channels", table: "channels_channels", shape: "list", column: "id", id }],
  empty: () => ({ channels: [] }),
};
const CHANNEL_LOGS = "channels";
const isLog = (file: string): boolean => file.startsWith(`${CHANNEL_LOGS}/`) && file.endsWith(".jsonl");

/**
 * channels.json and the post logs `channels/<id>.jsonl` from before phase 5, kept so nothing of them is lost; each log line is one row, as
 * the file holds it. Nothing writes them, so their files move to json-archive a week after the import.
 */
export const CHANNELS: JsonKind = (() => {
  const list = docKind(CHANNEL_LIST);
  const lines = (db: DatabaseSync, file: string) =>
    db.prepare("SELECT text FROM channels_lines WHERE file = ? ORDER BY n").all(file) as { text: string }[];
  return {
    kind: "channels",
    migrations: [`${list.migrations[0]};\nCREATE TABLE channels_lines (file TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (file, n))`],
    files(dir) {
      const logs = existsSync(join(dir, CHANNEL_LOGS)) ? readdirSync(join(dir, CHANNEL_LOGS)).filter(f => f.endsWith(".jsonl")).sort() : [];
      return [...list.files(dir), ...logs.map(f => `${CHANNEL_LOGS}/${f}`)];
    },
    load(db, file, text) {
      if (!isLog(file)) return list.load(db, file, text);
      db.prepare("DELETE FROM channels_lines WHERE file = ?").run(file);
      const insert = db.prepare("INSERT INTO channels_lines (file, n, text) VALUES (?, ?, ?)");
      text.split("\n").forEach((line, n) => insert.run(file, n, line));
      return text.split("\n").filter(line => line.trim()).length;
    },
    records: (file, text) => (isLog(file) ? text.split("\n").filter(line => line.trim()).length : list.records(file, text)),
    count: (db, file) => (isLog(file) ? lines(db, file).filter(l => l.text.trim()).length : list.count(db, file)),
    dump(db, file) {
      if (!isLog(file)) return list.dump(db, file);
      const rows = lines(db, file);
      return rows.length ? rows.map(r => r.text).join("\n") : null;
    },
  };
})();

/** The channels of channels.json as the DB holds them. */
export function oldChannels(db: DatabaseSync): unknown[] {
  return (readDoc(db, CHANNEL_LIST as DocSpec<object>)?.value as { channels?: unknown[] } | undefined)?.channels ?? [];
}

/** The text of `channels/<channel>.jsonl` as the DB holds it, or undefined when it held no such file. */
export function oldChannelLog(db: DatabaseSync, channel: string): string | undefined {
  const rows = db.prepare("SELECT text FROM channels_lines WHERE file = ? ORDER BY n").all(`${CHANNEL_LOGS}/${channel}.jsonl`) as { text: string }[];
  return rows.length ? rows.map(r => r.text).join("\n") : undefined;
}

