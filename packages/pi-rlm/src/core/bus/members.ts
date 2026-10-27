/**
 * Every member pi-agent-bus can see from this process: sessions in `pi-family/registry.ts`, dormant rows that pi-rlm and pi-host registered,
 * and, in a plain `pi` CLI with `PI_HOST_SOCKET` set, the roots that pi-host holds.
 */

import * as registry from "@sieun-pi/pi-family/registry";
import type { AgentEntry, DormantAgent } from "@sieun-pi/pi-family/registry";
import type { Member } from "./family.ts";
import { hostRoots, localRoute, otherBoxes, type HostRoot, type Route } from "./host-socket.ts";
import { hostApi } from "@sieun-pi/pi-family/host-api";

export type Known =
  | { kind: "live"; member: Member; entry: AgentEntry }
  | { kind: "dormant"; member: Member; row: DormantAgent }
  | { kind: "remote"; member: Member; root: HostRoot; route: Route };

export function memberOf(entry: Pick<AgentEntry, "id" | "name" | "role" | "parentId" | "depth">): Member {
  return { id: entry.id, name: entry.name, role: entry.role, depth: entry.depth, ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}) };
}

export function localMembers(): Known[] {
  const out: Known[] = registry.list().map(entry => ({ kind: "live", member: memberOf(entry), entry }));
  for (const row of registry.dormant()) out.push({ kind: "dormant", member: memberOf(row), row });
  return out;
}

function remoteKnown(root: HostRoot, route: Route): Known {
  return { kind: "remote", member: { id: root.sessionId, name: root.sessionName ?? root.sessionId, role: "root", depth: 0 }, root, route };
}

/**
 * Local members, plus the roots this process can reach elsewhere: this box's pi-host over `PI_HOST_SOCKET` when this process is not the host,
 * and every other box in `PI_AGENT_BUS_BOXES` through its prime-relay. A box that does not answer adds no roots.
 */
export async function allMembers(): Promise<Known[]> {
  const out = localMembers();
  const seen = new Set(out.map(k => k.member.id));
  const routes: Route[] = [];
  if (!hostApi() && process.env.PI_HOST_SOCKET) routes.push(localRoute());
  for (const box of otherBoxes()) routes.push({ box });
  const lists = await Promise.allSettled(routes.map(route => hostRoots(route).then(roots => ({ route, roots }))));
  for (const list of lists) {
    if (list.status !== "fulfilled") continue;
    for (const root of list.value.roots) {
      if (seen.has(root.sessionId)) continue;
      seen.add(root.sessionId);
      out.push(remoteKnown(root, list.value.route));
    }
  }
  return out;
}
