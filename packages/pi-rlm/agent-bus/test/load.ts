/**
 * The step 3 check: many senders send many messages each to one busy receiver, and delivery is counted at the receiver's transcript file.
 * `bus.load.test.ts` runs it in-process, and `scripts/host-load.ts` runs the same count through pi-host.
 */

import type { DeliveryMode } from "../../../pi-family/registry.ts";
import { landed } from "./rig.ts";

export interface LoadResult {
  senders: number;
  perSender: number;
  sent: number;
  accepted: number;
  rejected: string[];
  landed: number;
  unique: number;
  duplicates: number;
  missing: number;
  unexpected: number;
  outOfOrderSenders: number;
  receipts: { delivered: number; queued: number; overLimit: number };
  sendMs: number;
  drainMs: number;
}

export const MODES: DeliveryMode[] = ["auto", "steer", "follow_up"];

export function body(sender: number, seq: number): string {
  return `load s${String(sender).padStart(2, "0")} n${String(seq).padStart(2, "0")}`;
}

/**
 * Runs `senders` concurrent loops of `perSender` awaited sends each, then waits until the receiver is idle and reads its file.
 * `sendOne` returns the receipt the sender got.
 */
export async function runLoad(opts: {
  senders: number;
  perSender: number;
  sendOne: (sender: number, seq: number, mode: DeliveryMode) => Promise<{ id: string; deliveryStatus: string; overLimit?: string[] }>;
  receiverFile: () => string | undefined;
  receiverIdle: () => boolean;
  drainTimeoutMs?: number;
  /** A random pause of up to this many ms before each send, so sends land while the receiver starts, runs and settles. */
  jitterMs?: number;
}): Promise<LoadResult> {
  const ids = new Map<string, string>();
  const rejected: string[] = [];
  const receipts = { delivered: 0, queued: 0, overLimit: 0 };
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: opts.senders }, async (_, s) => {
      for (let n = 0; n < opts.perSender; n += 1) {
        if (opts.jitterMs) await new Promise(resolve => setTimeout(resolve, Math.random() * opts.jitterMs!));
        try {
          const r = await opts.sendOne(s, n, MODES[s % MODES.length]);
          ids.set(r.id, body(s, n));
          if (r.deliveryStatus === "delivered") receipts.delivered += 1;
          else receipts.queued += 1;
          if (r.overLimit?.length) receipts.overLimit += 1;
        } catch (error) {
          rejected.push(`${body(s, n)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }),
  );
  const sendMs = Date.now() - t0;
  const t1 = Date.now();
  const expected = opts.senders * opts.perSender;
  const deadline = Date.now() + (opts.drainTimeoutMs ?? 120_000);
  let got = landed(opts.receiverFile()).filter(m => m.message.startsWith("load "));
  while (Date.now() < deadline && !(got.length >= ids.size && opts.receiverIdle())) {
    await new Promise(resolve => setTimeout(resolve, 100));
    got = landed(opts.receiverFile()).filter(m => m.message.startsWith("load "));
  }
  const drainMs = Date.now() - t1;
  const seen = new Map<string, number>();
  for (const m of got) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
  const duplicates = [...seen.values()].filter(c => c > 1).reduce((a, c) => a + c - 1, 0);
  const missing = [...ids.keys()].filter(id => !seen.has(id)).length;
  const unexpected = [...seen.keys()].filter(id => !ids.has(id)).length;
  const order = new Map<string, number[]>();
  for (const m of got) {
    const match = /^load (s\d+) n(\d+)$/.exec(m.message);
    if (!match) continue;
    order.set(match[1], [...(order.get(match[1]) ?? []), Number(match[2])]);
  }
  const outOfOrderSenders = [...order.values()].filter(seq => seq.some((v, i) => i > 0 && v < seq[i - 1])).length;
  return {
    senders: opts.senders,
    perSender: opts.perSender,
    sent: expected,
    accepted: ids.size,
    rejected,
    landed: got.length,
    unique: seen.size,
    duplicates,
    missing,
    unexpected,
    outOfOrderSenders,
    receipts,
    sendMs,
    drainMs,
  };
}
