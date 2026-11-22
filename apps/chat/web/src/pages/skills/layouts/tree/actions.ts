/**
 * The skill changes this layout makes. The owner's click is his approval, so a change runs at once, the view reads again, and a toast
 * offers Undo, which calls the move's undo on the server.
 */
import { api } from "$lib/api";
import type { SkillsChange } from "$lib/api/shared/skills";
import { toast } from "$lib/ui";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a change is called while it runs and once it is done, such as "Adding why" and "Added why to ~/.codex/skills". */
export type ChangeWords = { doing: string; done: string };

export function changeText(done: string, change: SkillsChange): string {
  const steps = change.apply?.steps ?? [];
  const queued = [...new Set(steps.filter(s => s.result === "queued").map(s => (s.box === "mac" ? "The Mac" : s.box)))];
  const failed = steps.filter(s => s.result === "failed");
  const parts = [done];
  if (queued.length) parts.push(`${queued.join(" and ")} ${queued.length === 1 ? "gets" : "get"} it when ${queued.length === 1 ? "it wakes" : "they wake"}.`);
  if (failed.length) parts.push(`${failed.length} ${failed.length === 1 ? "step" : "steps"} failed: ${failed.map(s => s.note ?? s.path).join("; ")}`);
  return parts.join(" ");
}

export async function act(words: ChangeWords, run: () => Promise<SkillsChange>, reload: () => Promise<void>): Promise<boolean> {
  let change: SkillsChange;
  try {
    change = await run();
  } catch (error) {
    toast.error(`${words.doing} failed: ${reason(error)}`);
    return false;
  }
  await reload();
  const failed = change.apply?.steps.some(s => s.result === "failed") ?? false;
  const undo = { label: "Undo", run: () => void undoMove(words, change.move.id, reload) };
  if (failed) toast.error(changeText(`${words.done}.`, change), { action: undo, duration: 12_000 });
  else toast.success(changeText(`${words.done}.`, change), { action: undo, duration: 12_000 });
  return true;
}

async function undoMove(words: ChangeWords, moveId: string, reload: () => Promise<void>): Promise<void> {
  try {
    const change = await api.undoSkillMove({ moveId });
    await reload();
    toast.show(changeText(`Undid: ${words.done}.`, change));
  } catch (error) {
    toast.error(`Undo failed: ${reason(error)}`);
  }
}
