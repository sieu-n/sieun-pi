/**
 * Tells each chat what nobody owns on its board: its open steps nobody moves and its red duties with no live fix, by the rules the Chat system
 * duty (d9) counts them with (legacy/prime/user-history/src/apps-step-owners.ts), as today's chat service tells a Prime chat its unmoved steps
 * (`Chats.unmoved`). A chat is told when a gap appears and again each live window while the same gaps stay, never while its own turn or a duty run
 * works. Until 11-03 the :5184 check-in only said "move each open step", and d9 found vent's p126 and chrome extension's p20 each waiting with no
 * wake and no job, which no part of the app had named to its chat.
 */
import { appsGapsKey, appsOwnerGaps, appsOwnerNotice, type AppsChat } from "../../../legacy/prime/user-history/src/apps-step-owners.ts";
import { liveWindowMs } from "../../../legacy/prime/user-history/src/checkin-steps.ts";
import { pendingWakes } from "../../../legacy/prime/user-history/src/wakes.ts";
import type { Boards } from "./boards.ts";

export class StepOwners {
  private readonly told = new Map<string, { key: string; at: number }>();
  private running = false;

  constructor(private readonly boards: Boards, private readonly log: (line: string) => void = () => {}) {}

  /** Each chat of the app (not archived, its box up) as d9 reads it through `GET /api/agents/:id/...`. */
  async chats(): Promise<AppsChat[]> {
    const agents = this.boards.threads.agents().filter(agent => agent.kind === "chat" && !agent.archived && agent.hostState !== "away");
    return Promise.all(agents.map(async (agent): Promise<AppsChat> => ({
      id: agent.id, name: agent.name, board: await this.boards.board(agent.id), thread: agent.thread, working: agent.status === "working", updatedAt: agent.updatedAt,
      duties: this.boards.duties(agent.id).map(row => ({ duty: row.duty, paused: row.paused, running: row.running, runs: row.runs, schedule: row.schedule,
        ...row.nextAt !== null ? { nextAt: row.nextAt } : {} })),
      jobs: this.boards.chatAgents(agent.id), everyMs: this.boards.checkIn(agent.id).everyMs,
    })));
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const chats = await this.chats();
      const sessions = this.boards.threads.conversations();
      const wakes = await pendingWakes(this.boards.wakeDir, now);
      const links = { others: new Map(chats.map(chat => [chat.id, chat.board] as const)), chats: chats.map(chat => ({ id: chat.id, name: chat.name })) };
      for (const chat of chats) {
        if (!chat.thread || this.boards.rootRunning(chat.thread) || chat.duties.some(row => row.running)) continue;
        const gaps = appsOwnerGaps(chat, sessions, wakes, now, { self: chat.id, ...links });
        const key = appsGapsKey(gaps);
        if (!key) { this.told.delete(chat.id); continue; }
        const window = liveWindowMs(chat.everyMs ?? Infinity);
        const last = this.told.get(chat.id);
        if (last?.key === key && now - last.at < window) continue;
        await this.boards.host.submit(chat.thread, {
          text: appsOwnerNotice(gaps, window), whenBusy: "followUp", requestId: `owners:${chat.id}:${now}`,
          entry: { kind: "agent.message", data: { from: "board", via: "owners" } },
        }).then(() => {
          this.told.set(chat.id, { key, at: now });
          this.log(`owners: told ${chat.name} nobody owns ${key}`);
        }, error => this.log(`owners: telling ${chat.name} failed: ${String(error)}`));
      }
    } finally {
      this.running = false;
    }
  }
}
