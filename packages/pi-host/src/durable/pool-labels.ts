/**
 * How pi-host labels an agent's threads to pi-pool, so a sw factory agent asks the pool the way a Prime chat does:
 *
 * 1. Tree: a comm thread runs in its agent's work thread's pool tree, `pi-durable:<work thread>`, so a new room's comm thread takes the
 *    account the work thread holds and pays no admission of its own. Every other thread is its own tree, `pi-durable:<thread>`.
 * 2. Class: the agent's work tree is high, as the chat service gives each Prime chat (`chatPoolPriority` in
 *    legacy/prime/user-history/src/chat-pool-priority.ts), and a job filed under the agent is high too, as a Prime job takes its chat's
 *    class. A duty job is low, and a check-in or Wiki dream duty job normal, as Prime's `dutyJobPriority` gives them. A thread with no
 *    agent keeps the pool's default.
 * 3. Lead: an open comm thread's root session is on the turn queue's lead list, as the chat service puts each Prime chat head there
 *    (`leadWriter` in legacy/prime/user-history/src/chat-hosts.ts), so its queued runs start before every job run. pi-host adds and drops
 *    only its own ids (`pi-pool lead --add|--drop`), and the chat service's writer keeps every id it did not write.
 *
 * From 11-02 11:27Z to 11-03 11:27Z on us-metal02, pi-host runs waited p50 58 s and p90 618 s in the turn queue, and Prime chat heads 0 s
 * and 8 s, because no pi-host tree asked as high and no comm thread was on the lead list; a new room's comm thread waited 29 min for its
 * own account while its work thread held one (~/work/agent-turn-slot-waits/numbers.md).
 */
import type { PoolClass } from "@sieun-pi/pi-pool/durable";
import type { AgentRef } from "./agent-profile.ts";

/** The pool calls the labels need; pi-host passes its TurnQueue. */
export interface PoolLabelCalls {
  treeClass(tree: string, priority: PoolClass): Promise<"set" | "kept" | "failed">;
  lead(op: "add" | "drop", session: string): Promise<boolean>;
}

/** A thread's own pool tree. */
export const ownTree = (thread: string): string => `pi-durable:${thread}`;

/** A duty job's name, `<duty name> duty <yymmdd-hhmmss>` (`runStamp` in apps/chat/server/duty-run.ts). */
const DUTY_JOB = / duty \d{6}-\d{6}$/;

/** The class a thread's agent role asks for, by Prime's rules; undefined for a thread with no agent. */
export function threadClass(ref: AgentRef | undefined, name: string): PoolClass | undefined {
  if (!ref) return undefined;
  if (ref.role !== "job" || !DUTY_JOB.test(name)) return "high";
  const duty = name.replace(DUTY_JOB, "").trim().toLowerCase();
  return duty === "check-in" || duty.startsWith("wiki dream") ? "normal" : "low";
}

export class PoolLabels {
  /** Each comm thread's work thread, whose tree it runs in. */
  private readonly work = new Map<string, string>();
  /** Each open comm thread's root session, which this process put on the lead list. */
  private readonly leads = new Map<string, string>();
  /** The class this process gave or read on each tree, so it asks the pool once per tree. */
  private readonly classes = new Map<string, PoolClass>();
  /** Pool calls run one at a time, in order, so a drop never overtakes the add before it. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly calls: PoolLabelCalls, private readonly log: (line: string) => void = () => {}) {}

  /** The pool tree a thread's requests ask for now. */
  tree(thread: string): string {
    return ownTree(this.work.get(thread) ?? thread);
  }

  /**
   * A thread opened or got its `agent.ref`: set its tree at once, before its first request, then its tree's class and its lead place in the
   * background. `rootSession` is the root conversation's session, which only a comm thread needs.
   */
  agent(thread: { id: string; name: string }, ref: AgentRef | undefined, rootSession?: string): void {
    if (ref?.role === "comm") this.work.set(thread.id, ref.work);
    else this.work.delete(thread.id);
    const priority = threadClass(ref, thread.name);
    const tree = this.tree(thread.id);
    if (priority && this.classes.get(tree) !== priority) {
      this.classes.set(tree, priority);
      this.run(async () => {
        const done = await this.calls.treeClass(tree, priority);
        if (done === "failed") {
          this.classes.delete(tree);
          this.log(`pool class ${priority} for ${tree} failed; the thread's next open tries again`);
        } else if (done === "set") this.log(`pool class ${priority} for ${tree}`);
      });
    }
    if (ref?.role === "comm" && rootSession) this.lead(thread.id, rootSession);
    else this.closed(thread.id);
  }

  /**
   * An input reached a thread's root conversation: a comm thread's session goes on the lead list again, since the chat service's
   * replace of the list can race an add and drop it.
   */
  submitted(thread: string): void {
    const session = this.leads.get(thread);
    if (session) this.lead(thread, session, true);
  }

  /** A thread's file closed: its comm session leaves the lead list until the thread opens again. */
  closed(thread: string): void {
    const session = this.leads.get(thread);
    if (!session) return;
    this.leads.delete(thread);
    this.run(async () => {
      if (!await this.calls.lead("drop", session)) this.log(`lead list drop of ${session} (${thread}) failed`);
    });
  }

  private lead(thread: string, session: string, again = false): void {
    if (!again && this.leads.get(thread) === session) return;
    this.leads.set(thread, session);
    this.run(async () => {
      if (!await this.calls.lead("add", session)) this.log(`lead list add of ${session} (${thread}) failed`);
    });
  }

  /** Waits for every pool call asked so far. */
  settled(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private run(call: () => Promise<void>): void {
    this.tail = this.tail.then(call).catch(error => this.log(`pool label call failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
