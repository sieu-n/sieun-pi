import type { DutyView } from "./chat-duties.ts";
import type { AccountsView, ChildUsage } from "./types.ts";

/**
 * What a thread's first paint shows beside its messages, pushed on its feed as `side` frames after the snapshot so the page asks for none of it
 * (chat-server.ts `pushSide`). On 10-18 the page asked for these only after the snapshot landed, a round trip of 150 to 200 ms from Korea each.
 * Each frame holds the parts that are ready: job costs at once, the chat's duties and the accounts list when they are read.
 * `accounts.model` is the model id the view was judged for, the key the page caches it under (client/accounts.ts).
 */
export interface ThreadSide { childUsage?: ChildUsage[]; duties?: DutyView[]; accounts?: { model: string | null; view: AccountsView } }
