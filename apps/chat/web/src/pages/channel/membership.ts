import { api, type AgentId, type Member, type RoomId } from "$lib/api";
import { toast } from "$lib/ui/toast.svelte";

/**
 * One agent's place in one channel or Solo room, with the names its toasts say. The channel member list, the Solo roster and an agent's
 * Work tab all add and remove through these, so each change reads the page again and says the same thing.
 */
export type Membership = { room: RoomId; roomName: string; agent: AgentId; agentName: string };
export type MembershipOpts = { wakeOn?: Member["wakeOn"]; refresh: () => Promise<void> | void };

/**
 * What the one add picker (MemberPicker.svelte) adds to. From a room it lists the agents not in it, only test agents in a walk's test room;
 * from an agent it lists the open channels and Solo rooms it is not in, only test rooms for a test agent.
 */
export type MemberTarget =
  | { kind: "room"; room: RoomId; name: string; members: readonly AgentId[]; test: boolean }
  | { kind: "agent"; agent: AgentId; name: string; rooms: readonly RoomId[]; test: boolean };

const where = (m: Membership): string => (m.room.startsWith("ch_") ? `#${m.roomName}` : m.roomName);
const names = (list: readonly string[]): string => {
  const unique = [...new Set(list)];
  return unique.length < 3 ? unique.join(" and ") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
};
const failed = (error: unknown): false => {
  toast.error(error instanceof Error ? error.message : "That did not work");
  return false;
};

/**
 * Adds every pick of one picker at once: one call per room, so several agents into one room is one call, and one toast, "Added A, B and C
 * to #x" or "Added A to #x and Solo". Resolves false when an add failed, after its error toast; the adds that worked still show.
 */
export async function addMemberships(batch: readonly Membership[], opts: MembershipOpts): Promise<boolean> {
  if (!batch.length) return true;
  const rooms = new Map<RoomId, Membership[]>();
  for (const m of batch) rooms.set(m.room, [...(rooms.get(m.room) ?? []), m]);
  const results = await Promise.allSettled([...rooms].map(([room, group]) => api.addMembers(room, group.map((m) => m.agent), opts.wakeOn).then(() => group)));
  const added = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failure = results.find((r) => r.status === "rejected");
  try {
    if (added.length) {
      await opts.refresh();
      toast.success(`Added ${names(added.map((m) => m.agentName))} to ${names(added.map(where))}`);
    }
  } catch (error) {
    return failed(error);
  }
  return failure ? failed(failure.reason) : true;
}

/** Sets whether the agent wakes on every post in the room or only on mentions. Resolves false when the change failed, after its error toast. */
export async function setWakeOn(m: Membership, wakeOn: Member["wakeOn"], opts: Pick<MembershipOpts, "refresh">): Promise<boolean> {
  try {
    await api.setMemberWakeOn(m.room, m.agent, wakeOn);
    await opts.refresh();
    return true;
  } catch (error) {
    return failed(error);
  }
}

/**
 * Removes at once and offers Undo, which adds the agent back with the wake setting it had: the one the server's answer names, since the page
 * may show a kept answer from before a change of it, or `opts.wakeOn` when a second try of the call found the agent gone already.
 * Resolves false when the remove failed.
 */
export async function removeMembership(m: Membership, opts: MembershipOpts): Promise<boolean> {
  let wakeOn = opts.wakeOn;
  try {
    wakeOn = (await api.removeMember(m.room, m.agent)).removed?.wakeOn ?? wakeOn;
    await opts.refresh();
  } catch (error) {
    return failed(error);
  }
  const undo = async () => {
    try {
      await api.addMembers(m.room, [m.agent], wakeOn);
      await opts.refresh();
      toast.show(`${m.agentName} is back in ${where(m)}`);
    } catch (error) {
      failed(error);
    }
  };
  toast.show(`Removed ${m.agentName} from ${where(m)}`, { action: { label: "Undo", run: () => void undo() } });
  return true;
}
