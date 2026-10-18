/*
 * The owner's sends survive a slow or restarting daemon and a page reload (owner, 10-18 08:16Z: a send to the AI harness chat bounced with
 * 'Timed out after 30000ms waiting for the Prime Agent daemon response to "attach"' and a red banner). The page keeps each send in its own
 * durable outbox until the server holds it, and the server keeps it on disk until the daemon takes it. `id` is the page's message id, sent as
 * the POST's requestId, so a resend from either side is the same message and goes to the daemon once.
 */

/**
 * queued: on the server's disk, waiting for the daemon. sending: a delivery is in flight. delivered: the daemon took it. failed: it cannot go
 * (the note says why). obsolete: an agent message proved needless before it went (src/agent-outbox.ts), kept with the proof and never sent.
 */
export type OutboxState = "queued" | "sending" | "delivered" | "failed" | "obsolete";

export interface OutboxEntry {
  id: string;
  threadId: string;
  text: string;
  /** Count only; the image bytes stay on the server's disk and in the page's outbox. */
  imageCount: number;
  state: OutboxState;
  /** Epoch ms when the page made the send. */
  at: number;
  attempts: number;
  /** Plain words for the inline note on "failed", and the proof on "obsolete". */
  error?: string;
}

/** The POST api/threads/:id/prompt answer once the send is on the server's disk; `accepted` stays for callers that only read it. */
export interface OutboxAccepted { accepted: true; outbox: OutboxEntry }
