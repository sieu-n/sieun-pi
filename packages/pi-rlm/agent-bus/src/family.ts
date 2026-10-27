/**
 * Prime's reach rule over registry identities: a member is the parent, a sibling or a direct child, and every root is a sibling of every
 * other root. Anything else is out of reach.
 */

import type { AgentRole } from "@sieun-pi/pi-family/registry";

export type Relationship = "parent" | "sibling" | "child";

export interface Member {
  id: string;
  name: string;
  role: AgentRole;
  parentId?: string;
  depth: number;
}

export const REACH_ERROR = "Agent reach is limited to parent, siblings, and children";

/** What `other` is to `self`. */
export function relationship(self: Member, other: Member): Relationship | undefined {
  if (self.id === other.id) return undefined;
  if (self.parentId !== undefined && other.id === self.parentId) return "parent";
  if (other.parentId !== undefined && other.parentId === self.id) return "child";
  if (self.depth !== other.depth) return undefined;
  if (self.parentId !== undefined && self.parentId === other.parentId) return "sibling";
  if (self.depth === 0 && self.parentId === undefined && other.parentId === undefined) return "sibling";
  return undefined;
}

const ORDER: Record<Relationship, number> = { parent: 0, sibling: 1, child: 2 };

/** Prime's roster order: the parent, then siblings by name, then children by name. The first row for an id wins. */
export function family<T extends { member: Member }>(self: Member, items: Iterable<T>): { relationship: Relationship; item: T }[] {
  const out: { relationship: Relationship; item: T }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.member.id)) continue;
    seen.add(item.member.id);
    const rel = relationship(self, item.member);
    if (rel) out.push({ relationship: rel, item });
  }
  return out.sort((a, b) => ORDER[a.relationship] - ORDER[b.relationship] || a.item.member.name.localeCompare(b.item.member.name));
}
