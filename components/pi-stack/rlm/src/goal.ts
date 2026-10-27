import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A thread goal, as Prime's `goal` skill reads it. pi-host's scheduler (build step 6) owns the continuation prompts that pursue it. */
export interface Goal {
  objective: string;
  status: "active" | "paused" | "budget_limited" | "complete" | "error";
  token_budget: number | null;
  tokens_used: number;
  created_at: number;
  completed_at: number | null;
}

export const GOAL_ENTRY = "rlm_goal";

/** Goal state for one session, kept as `rlm_goal` custom entries so it survives reload, compaction and a host restart. */
export class GoalState {
  goal: Goal | null = null;

  constructor(private readonly pi: ExtensionAPI) {}

  load(ctx: ExtensionContext): void {
    this.goal = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === GOAL_ENTRY) this.goal = (entry.data as Goal | null) ?? null;
    }
  }

  private save(): void {
    this.pi.appendEntry(GOAL_ENTRY, this.goal);
    this.pi.events.emit("rlm:goal", this.goal);
  }

  /** Counts one assistant message's tokens against an active goal and moves it to budget_limited when the budget runs out. */
  countTokens(tokens: number): void {
    const g = this.goal;
    if (!g || g.status !== "active" || !tokens) return;
    g.tokens_used += tokens;
    if (g.token_budget !== null && g.tokens_used >= g.token_budget) g.status = "budget_limited";
    this.save();
  }

  view(): Record<string, unknown> {
    const g = this.goal;
    const remaining = g && g.token_budget !== null ? Math.max(0, g.token_budget - g.tokens_used) : null;
    return {
      goal: g ? { ...g, elapsed_ms: (g.completed_at ?? Date.now()) - g.created_at } : null,
      remaining_tokens: remaining,
      completion_budget_report: g && g.token_budget !== null ? `${g.tokens_used} of ${g.token_budget} tokens used` : null,
    };
  }

  create(payload: Record<string, unknown>): Record<string, unknown> {
    const objective = payload.objective;
    if (typeof objective !== "string" || !objective.trim()) throw new Error("goal.create needs a non-empty objective");
    const budget = payload.token_budget;
    if (budget !== undefined && (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0)) throw new Error("token_budget must be a positive int");
    if (this.goal && (this.goal.status === "active" || this.goal.status === "paused" || this.goal.status === "budget_limited")) {
      throw new Error("a goal is still pending; complete it before you create another");
    }
    this.goal = { objective: objective.trim(), status: "active", token_budget: (budget as number | undefined) ?? null, tokens_used: 0, created_at: Date.now(), completed_at: null };
    this.save();
    return this.view();
  }

  complete(): Record<string, unknown> {
    if (!this.goal) throw new Error("no goal is set");
    this.goal.status = "complete";
    this.goal.completed_at = Date.now();
    this.save();
    return this.view();
  }
}
