/**
 * Every member pi-agent-bus can see from this process: sessions in `shared/registry.ts`, dormant rows that pi-rlm and pi-host registered,
 * and, in a plain `pi` CLI with `PI_HOST_SOCKET` set, the roots that pi-host holds.
 */

import * as registry from "../../shared/registry.ts";
import type { AgentEntry, DormantAgent } from "../../shared/registry.ts";
import type { Member } from "./family.ts";
import { hostRoots, type HostRoot } from "./host-socket.ts";
import { hostApi } from "../../host/src/api.ts";

export type Known =
  | { kind: "live"; member: Member; entry: AgentEntry }
  | { kind: "dormant"; member: Member; row: DormantAgent }
  | { kind: "remote"; member: Member; root: HostRoot };

export function memberOf(entry: Pick<AgentEntry, "id" | "name" | "role" | "parentId" | "depth">): Member {
  return { id: entry.id, name: entry.name, role: entry.role, depth: entry.depth, ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}) };
}

export function localMembers(): Known[] {
  const out: Known[] = registry.list().map(entry => ({ kind: "live", member: memberOf(entry), entry }));
  for (const row of registry.dormant()) out.push({ kind: "dormant", member: memberOf(row), row });
  return out;
}

/** Local members, plus pi-host's roots when this process is not the host but can reach one. */
export async function allMembers(): Promise<Known[]> {
  const local = localMembers();
  if (hostApi() || !process.env.PI_HOST_SOCKET) return local;
  const ids = new Set(local.map(k => k.member.id));
  const remote = (await hostRoots()).filter(root => !ids.has(root.sessionId));
  return [...local, ...remote.map(root => ({ kind: "remote" as const, member: { id: root.sessionId, name: root.sessionName ?? root.sessionId, role: "root" as const, depth: 0 }, root }))];
}
