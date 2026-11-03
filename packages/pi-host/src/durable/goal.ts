/**
 * Prime's thread goal in a durable thread (prime-agent `core/goals.ts` and agent-session.ts `handleGoalHostRequest`): the `goal.get`,
 * `goal.create` and `goal.complete` host requests of the `goal` Python module, token accounting against the budget, and the
 * `[goal: continuation]` input after each settled run until the goal is complete. pi-rlm's `GoalState` holds the logic and the texts.
 *
 * Each conversation keeps its goal in its `prime.goal` document, with the newest entry whose usage was counted. Prime counts an assistant
 * message at its message_end; here each request and each settle first counts the assistant entries after that mark, so `goal.complete()`
 * still counts the turn that completes the goal, as Prime's does. A settled run with an active goal, a last message that is not an error or
 * an abort, and no rlm child or `bash()` handle out gets the continuation as a follow-up input; a child's notice or a bash notice starts a
 * later run whose settle sends it instead. Crossing the budget marks the goal budget_limited and steers Prime's budget-limit text in once.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { defineDoc, type ConversationId, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import { GoalState, type Goal } from "../../../pi-rlm/src/pi/goal.ts";
import type { HostCall, HostModule, HostModuleOptions } from "./host-modules.ts";

const context: Context = BACKGROUND_CONTEXT;
/** The page size of an entry scan, as threads.ts reads a conversation. */
const PAGE = 500;

/** A conversation's goal and how far its accounting got. */
export type GoalRecord = {
  goal: Goal | null;
  /** The newest entry already counted; entries after it are counted at the next request or settle. */
  accounted: number;
  /** The newest assistant entry a settle decided on, so a second settle of the same run sends no second continuation. */
  decided: number;
};

const empty = (): GoalRecord => ({ goal: null, accounted: 0, decided: 0 });

export const GoalDoc = defineDoc<GoalRecord>({
  kind: "prime.goal",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: empty,
  checkpointWhen: () => true,
});

type Assistant = Message & { role: "assistant"; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
const assistantOf = (entry: EntryRecord): Assistant | undefined => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "assistant" ? (message as Assistant) : undefined;
};

/**
 * The objective of a conversation's goal, or "" when it has none: the text Prime ranks the harness digest by at weight 3
 * (`prime-harness.ts` `digestQueryTerms(input, recent, goal)`). Prime reads it whatever the goal's status.
 */
export async function goalObjective(harness: Harness, conversation: number): Promise<string> {
  return (await harness.snapshot(GoalDoc, conversation as ConversationId, context))?.goal?.objective ?? "";
}

/** What a change leaves to send once the document is written. */
type Sends = { budget?: string; continuation?: string };
type Newest = Assistant & { entryId: number };

export function goalModule(options: HostModuleOptions): HostModule {
  const queues = new Map<string, Promise<unknown>>();
  /** Conversations whose goal this process has read; the first read restarts an active goal's clock, as Prime's session load does. */
  const loaded = new Set<string>();

  /** Runs one change of a conversation's goal at a time, so a settle and a request never write over each other. */
  const serial = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
    const kept = next.catch(() => undefined);
    queues.set(key, kept);
    void kept.then(() => { if (queues.get(key) === kept) queues.delete(key); });
    return next;
  };

  const send = (call: HostCall, kind: "continuation" | "budget-limit", text: string, requestId: string, whenBusy: "steer" | "followUp") =>
    void call.submit({ text, requestId, whenBusy, entry: { kind: "agent.message", data: { from: "goal", via: `goal-${kind}` } } })
      .catch(error => call.log(`goal ${kind} failed: ${error instanceof Error ? error.message : String(error)}`));

  /**
   * Reads the conversation's goal, counts the assistant entries after its mark, runs `change` and writes the result. A budget the count
   * crosses steers in the budget-limit text, and `change` may leave a continuation in `sends`. Both go out after the write, with request ids
   * that name the goal, so a retry sends neither twice. `newest` is the newest assistant entry the count read.
   */
  const update = <T>(call: HostCall, change: (state: GoalState, record: GoalRecord, newest: Newest | undefined, sends: Sends) => Promise<T> | T): Promise<T> => {
    const key = `${call.thread.id}:${call.conversation}`;
    return serial(key, async () => {
      const id = call.conversation as ConversationId;
      const conversation = await call.harness.conversation(id, context);
      if (!conversation) throw new Error(`thread ${call.thread.id} has no conversation ${call.conversation}`);
      const record = structuredClone((await call.harness.snapshot(GoalDoc, id, context)) ?? empty()) as GoalRecord;
      const state = new GoalState(() => {});
      state.goal = record.goal;
      if (!loaded.has(key)) {
        loaded.add(key);
        if (state.goal?.status === "active") state.goal.active_since = Date.now();
      }
      const sends: Sends = {};
      let newest: Newest | undefined;
      let cursor: Parameters<typeof conversation.entries>[2];
      do {
        const page = await conversation.entries({ order: "ascending", minEntryId: (record.accounted + 1) as EntryRecord["id"] }, PAGE, cursor, context);
        for (const entry of page.items) {
          record.accounted = Math.max(record.accounted, entry.id);
          const message = assistantOf(entry);
          if (!message) continue;
          newest = { ...message, entryId: entry.id };
          if (state.account(message)) sends.budget = state.message("budget_limit").content;
        }
        cursor = page.next;
      } while (cursor !== undefined);
      const result = await change(state, record, newest, sends);
      const goal = state.goal as Goal | null;
      await conversation.commit(async tx => {
        Object.assign(await tx.doc(GoalDoc, id), { goal, accounted: record.accounted, decided: record.decided });
      }, context);
      if (sends.budget && goal) send(call, "budget-limit", sends.budget, `goal-budget-limit:${goal.goal_id}`, "steer");
      if (sends.continuation && goal) send(call, "continuation", sends.continuation, `goal-continuation:${goal.goal_id}:${goal.continuations_used}`, "followUp");
      return result;
    });
  };

  return {
    name: "goal",
    types: ["goal.get", "goal.create", "goal.complete"],
    // The count before `goal.create` finds no active goal, so the turn that creates it is not spent on it, as in Prime, whose message_end
    // came before the cell; the count before `goal.complete` charges the completing turn.
    request: (call, type, payload) => update(call, state => {
      if (type === "goal.get") return state.view();
      if (type === "goal.create") return state.create(payload);
      if (type === "goal.complete") return state.complete();
      throw new Error(`unknown goal request type "${type}"`);
    }),
    settled: async call => {
      if (!(await call.harness.snapshot(GoalDoc, call.conversation as ConversationId, context))?.goal) return;
      await update(call, async (state, record, newest, sends) => {
        // A run that started meanwhile settles later; a second settle of the same run finds no newer assistant entry.
        if (!state.active || !newest || newest.entryId <= record.decided || (await call.running())) return;
        record.decided = newest.entryId;
        if (state.terminal(newest) || (await call.workOut())) return;
        sends.continuation = state.continuation().content;
      }).catch(error => options.log(`${call.session}: goal settle failed: ${error instanceof Error ? error.message : String(error)}`));
    },
  };
}
