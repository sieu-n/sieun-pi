import { nextMonday } from "$lib/remind";

/** Pause notifications, as Slack's pause menu offers it: three lengths, then tomorrow and next week at 9:00 AM. */
export type PausePreset = { id: "30m" | "1h" | "2h" | "tomorrow" | "next-week"; label: string; until: number };

const MINUTE = 60_000;

function tomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export function pausePresets(now = Date.now()): PausePreset[] {
  return [
    { id: "30m", label: "For 30 minutes", until: now + 30 * MINUTE },
    { id: "1h", label: "For 1 hour", until: now + 60 * MINUTE },
    { id: "2h", label: "For 2 hours", until: now + 120 * MINUTE },
    { id: "tomorrow", label: "Until tomorrow", until: tomorrowMorning(now) },
    { id: "next-week", label: "Until next week", until: nextMonday(now) },
  ];
}
