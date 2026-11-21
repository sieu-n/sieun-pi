/**
 * The skill changes this layout makes. The owner's click is his approval, so a change runs at once, the view reads again, and a toast
 * offers Undo, which calls the move's undo on the server.
 */
import { api } from "$lib/api";
import type { SkillsChange } from "$lib/api/shared/skills";
import { toast } from "$lib/ui";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function changeText(change: SkillsChange): string {
  const steps = change.apply?.steps ?? [];
  const queued = [...new Set(steps.filter(s => s.result === "queued").map(s => s.box))];
  const failed = steps.filter(s => s.result === "failed");
  const parts = [change.move.summary];
  if (queued.length) parts.push(`${queued.join(" and ")} ${queued.length === 1 ? "gets" : "get"} it when ${queued.length === 1 ? "it wakes" : "they wake"}.`);
  if (failed.length) parts.push(`${failed.length} ${failed.length === 1 ? "step" : "steps"} failed: ${failed.map(s => s.note ?? s.path).join("; ")}`);
  return parts.join(" ");
}

export async function act(what: string, run: () => Promise<SkillsChange>, reload: () => Promise<void>): Promise<boolean> {
  let change: SkillsChange;
  try {
    change = await run();
  } catch (error) {
    toast.error(`${what} failed: ${reason(error)}`);
    return false;
  }
  await reload();
  const failed = change.apply?.steps.some(s => s.result === "failed") ?? false;
  const undo = { label: "Undo", run: () => void undoMove(change.move.id, reload) };
  if (failed) toast.error(changeText(change), { action: undo, duration: 12_000 });
  else toast.success(changeText(change), { action: undo, duration: 12_000 });
  return true;
}

async function undoMove(moveId: string, reload: () => Promise<void>): Promise<void> {
  try {
    const change = await api.undoSkillMove({ moveId });
    await reload();
    toast.show(`Undone. ${changeText(change)}`);
  } catch (error) {
    toast.error(`Undo failed: ${reason(error)}`);
  }
}
