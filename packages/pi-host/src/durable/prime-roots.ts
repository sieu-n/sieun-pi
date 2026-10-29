/**
 * Prime root sessions as a durable thread's root reaches them with `agent_message` and `agent_observe`: every root on every box of hosts.json,
 * as a Prime root on this box sees its own family, and a send that hands the text to the legacy chat service's agent outbox.
 *
 * The listing is the two halves a Prime root's own roster has (user-history `message-limit-check.py`): this box's roots from its Prime
 * daemon's `list` (the live roster, top-level rows only), and the other boxes' roots from the chat service's `api/agent/siblings`, which
 * answers from its catalog of every box (src/cross-host-message.ts `otherBoxRoots`, archived roots left out) for a root of this box. A full
 * daemon list would also give this box's saved roots, but the Mac's took 11.0 s for 38 MB on 10-18 (src/session-peer.ts), so the live roster
 * it is, as in Prime.
 *
 * A send is a POST of `api/agent/notice` {to, message, root}: the outbox keeps it on disk, finds the box that runs the session, opens an
 * unloaded one from its file, retries, and sends a copy only once while an identical one waits (src/agent-outbox.ts `deliver`).
 */
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { chatService, serviceCall, throughRestart, type ChatService } from "../../../../legacy/prime/user-history/src/chat-host.ts";
import { rootsOf, type RootRow as ChatRootRow } from "../../../../legacy/prime/user-history/src/cross-host-message.ts";
import { loadHosts, selfHost, type HostsRegistry } from "../../../../legacy/prime/user-history/src/hosts.ts";
import { lineRequest } from "../../../pi-rlm/src/core/bus/host-socket.ts";
import { header } from "../../../pi-rlm/src/core/bus/message.ts";
import type { PrimeRootRow } from "./rlm.ts";

export interface PrimeListing {
  roots: PrimeRootRow[];
  /** Why some roots are missing, such as a chat service that did not answer; absent when the listing is whole. */
  missing?: string;
}

export interface PrimeRootsOptions {
  /** hosts.json; default `SIEUN_PI_HOSTS`, else ~/.config/sieun-pi/hosts.json. Without one, this box alone, on Prime's default socket. */
  hostsFile?: string;
  /** The live chat service's data dir, whose configuration.json has its port and token; default `AGENT_CHAT_SHARED_DIR`, else ~/.prime/agent/browser-chat. */
  chatDataDir?: string;
}

type DaemonRow = { sessionId?: unknown; activeSessionId?: unknown; sessionName?: unknown; firstMessage?: unknown; lifecycle?: unknown; activity?: unknown;
  runtimeKind?: unknown; rlmChildId?: unknown; rlmDepth?: unknown };
type SiblingRow = { sessionId?: unknown; activeSessionId?: unknown; sessionName?: unknown; status?: unknown; host?: unknown };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
/** The chat says `working` for a root that runs a turn; the roster says `running` everywhere else. */
const statusWord = (status: string): string => (status === "working" ? "running" : status);

/** The first line of a send to a Prime root, so the receiver answers by the thread's full id (the shared wire format). */
export function piThreadHeader(name: string, id: string): string {
  return `${header(name, "sibling").slice(0, -1)} (${id}, a pi-host thread); answer with agent_message.send(text, receiver_role="sibling", receiver_name=${JSON.stringify(id)})]`;
}

/** Every listing is read fresh: one took 0.25 to 0.33 s on us-metal02 on 10-29 with 237 roots, at a load average near 300. */
export class PrimeRoots {
  constructor(private readonly options: PrimeRootsOptions = {}) {}

  private service(): Promise<ChatService | null> {
    return chatService(this.options.chatDataDir ?? process.env.AGENT_CHAT_SHARED_DIR ?? join(homedir(), ".prime/agent/browser-chat"));
  }

  /** Every Prime root a thread's root may reach. */
  async list(): Promise<PrimeListing> {
    let registry: HostsRegistry | undefined;
    try { registry = await loadHosts(this.options.hostsFile); } catch { /* no hosts.json: this box alone */ }
    const self = registry ? selfHost(registry) : null;
    const box = self?.name ?? hostname().split(".")[0]!.toLowerCase();
    const socket = self?.daemonSocket ?? join("/tmp", `prime-agent-${process.getuid?.() ?? 0}`, "daemon.sock");
    const missing: string[] = [];
    let here: PrimeRootRow[] = [];
    try {
      here = this.local(await lineRequest({ socket }, { type: "list" }, { clientId: `pi-host-roots-${process.pid}`, id: randomUUID() }), box);
    } catch (error) {
      missing.push(`the Prime daemon on ${box} did not list its roots (${message(error)})`);
    }
    let there: PrimeRootRow[] = [];
    if (registry && registry.hosts.length > 1) {
      // The chat answers for a root it knows, and gives the roots on every box but that root's.
      const anchor = here[0];
      if (!anchor) missing.push(`the other boxes' roots need a live Prime root on ${box}, and none is listed`);
      else {
        try {
          const service = await this.service();
          if (!service) throw new Error("no chat service is set up on this box or in hosts.json");
          there = await this.siblings(service, anchor.id);
          // The chat names this box's roots too, from the first message in each session file where the daemon has no name (catalog
          // `sessionTitle`), asked for a root of another box. The daemon's `firstMessage` is a later message after a compaction or a resume.
          const away = there[0];
          const titles = away ? new Map((await this.siblings(service, away.id).catch(() => [])).filter(root => root.box === box).map(root => [root.id, root.name])) : new Map<string, string>();
          for (const root of here) root.name = titles.get(root.id) ?? root.name;
        } catch (error) {
          missing.push(`the other boxes' roots did not list (${message(error)})`);
        }
      }
    }
    return { roots: [...here, ...there], ...(missing.length ? { missing: missing.join("; ") } : {}) };
  }

  /** The chat service's roots on every box but the one that runs root `session`. */
  private async siblings(service: ChatService, session: string): Promise<PrimeRootRow[]> {
    const answer = await serviceCall<{ agents?: SiblingRow[] }>(service, `api/agent/siblings?session=${encodeURIComponent(session)}`);
    if (!answer) throw new Error("the chat service has no api/agent/siblings route");
    return (answer.agents ?? []).flatMap(row => {
      const id = text(row.sessionId);
      const host = text(row.host);
      if (!id || !host) return [];
      const activeId = text(row.activeSessionId);
      return [{ kind: "prime" as const, id, ...(activeId ? { activeId } : {}), name: text(row.sessionName) ?? "", box: host, status: statusWord(text(row.status) ?? "unknown") }];
    });
  }

  /** This box's top-level rows of a daemon `list`, archived ones left out, as the chat's `rootsOf` keeps them. */
  private local(data: unknown, box: string): PrimeRootRow[] {
    const sessions = (data as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(sessions)) throw new Error("the daemon's list has no sessions");
    const rows: ChatRootRow[] = [];
    for (const row of sessions as DaemonRow[]) {
      const sessionId = text(row.sessionId);
      if (!sessionId || row.runtimeKind === "subagent" || typeof row.rlmChildId === "string" || (typeof row.rlmDepth === "number" && row.rlmDepth > 0)) continue;
      const activeSessionId = text(row.activeSessionId);
      const lifecycle = text(row.lifecycle);
      const name = text(row.sessionName)?.replace(/\s+/g, " ").trim() || text(row.firstMessage)?.split("\n")[0]!.trim().slice(0, 80) || "";
      rows.push({ sessionId, ...(activeSessionId ? { activeSessionId } : {}), name, host: box, status: text(row.activity) ?? lifecycle ?? "unknown", ...(lifecycle ? { lifecycle } : {}) });
    }
    return rootsOf(rows, new Set()).filter(root => !root.archived).map(root => ({
      kind: "prime" as const, id: root.sessionId, ...(root.activeSessionId ? { activeId: root.activeSessionId } : {}), name: root.name, box: root.host, status: statusWord(root.status),
    }));
  }

  /** Hands `content` to the chat service's agent outbox for Prime root `id`; it waits through a chat service restart (chat-host.ts `throughRestart`). */
  async send(id: string, content: string): Promise<void> {
    const service = await this.service();
    if (!service) throw new Error("A send to a Prime session needs the chat service, and none is set up on this box or in hosts.json.");
    const answer = await throughRestart(() => serviceCall(service, "api/agent/notice", { to: id, message: content, root: id }));
    if (!answer) throw new Error("The chat service has no api/agent/notice route.");
  }
}
