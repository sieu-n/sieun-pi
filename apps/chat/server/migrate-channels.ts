/**
 * Moves the channels of before phase 5 onto rooms (apps/chat/docs/agent-model.md, phase 5; /home/sieun/work/phase5/contract.md). It reads
 * `channels.json` and `channels/<id>.jsonl` and writes each channel as a `RoomRow` of kind `channel` in `rooms.json` and each post as a
 * `RoomPost` in `rooms/<id>.jsonl`, through `AgentStore` only. Members, authors, mentions and delivery targets were work-thread ids; each one
 * maps through `agents.json` to its agent id, and an id no agent holds stays as it is and is listed in the report. It never changes
 * `channels.json` or an old log. A second run writes nothing, and a run after the old server wrote more posts appends only the posts the
 * room lacks by id. A dry run (`apply: false`) reads only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, ImageRef, Ms } from "../web/src/lib/api/types.ts";
import { AgentStore, type RoomDelivery, type RoomMember, type RoomPost, type RoomRow, type WakeOn } from "./agent-store.ts";
import { readJson } from "./store.ts";

// The shapes `server/store.ts` and `web/src/lib/api/types.ts` had before phase 5, copied here because phase 5 deletes them.
type OldDeliveryState = "queued" | "delivered" | "read" | "answered" | "no_reply" | "stopped" | "failed";
interface OldMember { principal: "owner" | string; role: "owner" | "member"; wakeOn: WakeOn; addedAt: Ms }
interface OldChannel { id: string; name: string; purpose: string; homeChat?: string; createdAt: Ms; archived: boolean; members: OldMember[] }
interface OldDelivery {
  target: string; name: string; state: OldDeliveryState; at: Ms; answer?: string; error?: string;
  thread: string; conversation: number; submission?: number; answerPost?: string;
}
export interface OldPost {
  id: string; seq: number; channel: string; author: "owner" | string; text: string; images: ImageRef[]; mentions: string[];
  threadRoot?: string; at: Ms; hops: number; requestId?: string; deliveries: OldDelivery[];
}
type OldLogLine = { t: "post"; post: OldPost } | { t: "delivery"; post: string; delivery: OldDelivery };

/** A delivery the old router left at any step before an answer was submitted; the post is history now, and nothing resubmits it. */
const STATE: Record<OldDeliveryState, RoomDelivery["state"]> = {
  queued: "delivered", delivered: "delivered", read: "delivered", answered: "delivered", no_reply: "delivered", stopped: "stopped", failed: "failed",
};

type ChannelRoom = Extract<RoomRow, { kind: "channel" }>;

export interface MemberMove { from: string; agent: AgentId; wakeOn: WakeOn; mapped: boolean }

export interface ChannelMove {
  room: ChannelRoom;
  /** `rooms.json` had a room with this id before the run, so the run kept that row as it was. */
  roomExisted: boolean;
  members: MemberMove[];
  ownerDropped: boolean;
  /** Posts in the old log. */
  posts: number;
  /** Old posts the room already has by id. */
  present: number;
  /** Old posts the run appends (dry run) or appended. */
  append: string[];
  /** Old posts that cannot keep their id and seq, because the room's log went its own way; the run writes none of them. */
  blocked: { post: string; reason: string }[];
  /** Members, authors, mentions and delivery targets no agent holds, kept as they are. */
  unmapped: string[];
}

export interface MigrateChannelsReport { apply: boolean; dataDir: string; channels: ChannelMove[]; unmapped: string[]; roomsWritten: number; postsWritten: number }

/** The channel's posts as the old server read them: post lines, then each delivery line replacing that target's delivery. */
export function readChannelLog(dataDir: string, channel: string): OldPost[] {
  const file = join(dataDir, "channels", `${channel}.jsonl`);
  if (!existsSync(file)) return [];
  const byId = new Map<string, OldPost>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: OldLogLine;
    try {
      parsed = JSON.parse(line) as OldLogLine;
    } catch {
      continue;
    }
    if (parsed.t === "post") {
      if (!byId.has(parsed.post.id)) byId.set(parsed.post.id, { ...parsed.post, deliveries: [...(parsed.post.deliveries ?? [])] });
      continue;
    }
    const post = byId.get(parsed.post);
    if (!post) continue;
    const index = post.deliveries.findIndex(d => d.target === parsed.delivery.target);
    if (index >= 0) post.deliveries[index] = parsed.delivery;
    else post.deliveries.push(parsed.delivery);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** The agent a thread id, conversation id `<thread>:<n>` or agent id names, through each agent's `workThread` and the `aliases`. */
function agentResolver(store: AgentStore): (id: string) => AgentId | undefined {
  const known = new Set(store.agents.agents.map(a => a.id));
  const byThread = new Map<string, AgentId>(Object.entries(store.agents.aliases));
  for (const record of store.agents.agents) byThread.set(record.workThread, record.id);
  return id => {
    if (known.has(id)) return id;
    return byThread.get(id) ?? byThread.get(id.replace(/:\d+$/, ""));
  };
}

export function migrateChannels(dataDir: string, opts: { apply: boolean }): MigrateChannelsReport {
  const store = new AgentStore(dataDir);
  const rows = readJson<{ channels: OldChannel[] }>(join(dataDir, "channels.json"), { channels: [] }).channels;
  const resolve = agentResolver(store);
  const allUnmapped = new Set<string>();
  const moves: ChannelMove[] = [];
  let roomsWritten = 0;
  let postsWritten = 0;

  for (const row of rows) {
    const unmapped = new Set<string>();
    const agentOf = (id: string): string => {
      if (id === "owner") return id;
      const agent = resolve(id);
      if (agent) return agent;
      unmapped.add(id);
      return id;
    };

    const members: MemberMove[] = [];
    for (const member of row.members) {
      if (member.principal === "owner") continue;
      const agent = agentOf(member.principal);
      if (members.some(m => m.agent === agent)) continue;
      members.push({ from: member.principal, agent, wakeOn: member.wakeOn, mapped: !unmapped.has(member.principal) });
    }
    const existing = store.rooms.rooms.find(r => r.id === row.id);
    const room: ChannelRoom = existing?.kind === "channel" ? existing : {
      id: row.id, kind: "channel", name: row.name, purpose: row.purpose, ...(row.homeChat ? { homeChat: row.homeChat } : {}),
      createdAt: row.createdAt, archived: row.archived,
      members: members.map((m): RoomMember => ({ agent: m.agent, wakeOn: m.wakeOn, addedAt: row.members.find(o => o.principal === m.from)!.addedAt })),
    };
    const move: ChannelMove = {
      room, roomExisted: !!existing, members, ownerDropped: row.members.some(m => m.principal === "owner"),
      posts: 0, present: 0, append: [], blocked: [], unmapped: [],
    };
    moves.push(move);
    if (existing && existing.kind !== "channel") {
      move.blocked.push({ post: "*", reason: `rooms.json has a ${existing.kind} room with id ${row.id}` });
      continue;
    }
    if (!existing && opts.apply) {
      store.rooms.rooms.push(room);
      store.saveRooms();
      roomsWritten++;
    }

    const old = readChannelLog(dataDir, row.id);
    move.posts = old.length;
    const have = new Set(store.postsOf(row.id).map(p => p.id));
    let lastSeq = store.postsOf(row.id).at(-1)?.seq ?? 0;
    const keys = new Map<string, string>();
    for (const post of old) {
      // The post's dedup key: its own requestId, unless an earlier post in the log took it first or it has none.
      const own = post.requestId && !keys.has(post.requestId) ? post.requestId : `c:${row.id}:${post.id}`;
      keys.set(own, post.id);
      const draft = roomPost(row, post, own, agentOf);
      if (have.has(post.id)) {
        move.present++;
        continue;
      }
      const holder = store.byRequestId(row.id, own);
      if (post.id !== `p${post.seq}` || post.seq !== lastSeq + 1 || holder) {
        const reason = holder ? `requestId ${own} is held by ${holder.id}` : `the room's next post is p${lastSeq + 1}`;
        move.blocked.push({ post: post.id, reason });
        continue;
      }
      move.append.push(post.id);
      lastSeq = post.seq;
      if (!opts.apply) continue;
      const { post: written, created } = store.append(draft);
      if (!created || written.id !== post.id) throw new Error(`${row.id}: ${post.id} was written as ${written.id}; stopped so no later post shifts`);
      postsWritten++;
    }
    move.unmapped = [...unmapped];
    for (const id of unmapped) allUnmapped.add(id);
  }
  return { apply: opts.apply, dataDir, channels: moves, unmapped: [...allUnmapped], roomsWritten, postsWritten };
}

function roomPost(row: OldChannel, post: OldPost, requestId: string, agentOf: (id: string) => string): Omit<RoomPost, "id" | "seq"> {
  const mentions = [...new Set((post.mentions ?? []).map(agentOf))];
  return {
    room: row.id, author: agentOf(post.author), text: post.text, images: post.images ?? [], at: post.at, requestId,
    deliveries: post.deliveries.map((d): RoomDelivery => ({
      target: agentOf(d.target), state: STATE[d.state], attempts: d.submission !== undefined || d.state === "failed" ? 1 : 0, at: d.at,
      // The id the old router submitted with, so the delivery says what pi-host holds.
      requestId: `channel:${row.id}:${post.id}:${d.target}`,
      ...(d.submission !== undefined ? { submission: d.submission } : {}), ...(d.error ? { error: d.error } : {}),
    })),
    mentions, hops: post.hops ?? 0, ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
  };
}
