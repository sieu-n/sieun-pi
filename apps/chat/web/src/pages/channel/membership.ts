import { api, type AgentId, type Member, type RoomId } from "$lib/api";
import { toast } from "$lib/ui/toast.svelte";

/**
 * One agent's place in one channel or Solo room, with the names its toasts say. The channel member list, the Solo roster and an agent's
 * Work tab all add and remove through these two, so each change reads the page again and says the same thing.
 */
export type Membership = { room: RoomId; roomName: string; agent: AgentId; agentName: string };
export type MembershipOpts = { wakeOn?: Member["wakeOn"]; refresh: () => Promise<void> | void };

/**
 * What the one add picker (MemberPicker.svelte) adds to. From a room it lists the agents not in it, test agents too in a walk's test room;
 * from an agent it lists the channels it is not in, only test channels for a test agent.
 */
export type MemberTarget =
  | { kind: "room"; room: RoomId; name: string; members: readonly AgentId[]; test: boolean }
  | { kind: "agent"; agent: AgentId; name: string; rooms: readonly RoomId[]; test: boolean };

const where = (m: Membership): string => (m.room.startsWith("ch_") ? `#${m.roomName}` : m.roomName);
const failed = (error: unknown): false => {
  toast.error(error instanceof Error ? error.message : "That did not work");
  return false;
};

/** Resolves false when the add failed, after its error toast. */
export async function addMembership(m: Membership, opts: MembershipOpts): Promise<boolean> {
  try {
    await api.addMembers(m.room, [m.agent], opts.wakeOn);
    await opts.refresh();
    toast.success(`Added ${m.agentName} to ${where(m)}`);
    return true;
  } catch (error) {
    return failed(error);
  }
}

/** Removes at once and offers Undo, which adds the agent back with the wake setting it had. Resolves false when the remove failed. */
export async function removeMembership(m: Membership, opts: MembershipOpts): Promise<boolean> {
  try {
    await api.removeMember(m.room, m.agent);
    await opts.refresh();
  } catch (error) {
    return failed(error);
  }
  const undo = async () => {
    try {
      await api.addMembers(m.room, [m.agent], opts.wakeOn);
      await opts.refresh();
      toast.show(`${m.agentName} is back in ${where(m)}`);
    } catch (error) {
      failed(error);
    }
  };
  toast.show(`Removed ${m.agentName} from ${where(m)}`, { action: { label: "Undo", run: () => void undo() } });
  return true;
}
