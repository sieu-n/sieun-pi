import type { Scenario } from "./session-read.ts";

/**
 * Deferred admission for a clean-room scenario with fixture state: the chat is created with no first message and its check-in paused, its
 * fixtures and board are made, and only then does the head get its first message, after which the check-in resumes. In unrelated-ci-wait and
 * carried-wait setups the head got its first message at create, while setup was still making fixtures and seeding its board, so its first turn
 * could read or write a board that setup then overwrote (chat-2572 p20, 10-25).
 *
 * `admit` is the whole order, and each step is recorded in `AdmissionState` before the next one starts, so a setup run again after a crash or
 * a lost response resumes where it stopped. It never seeds a chat whose head already has its first message, never sends the first message
 * twice, and never backdates anything: each step's time is the clock's at that step.
 */
/** A scenario whose setup admits the head last (`admit`); its fixtures and board exist before the head's first message. */
export type DeferredScenario = Scenario & { deferAdmission: true };
export const isDeferred = (scenario: Scenario): scenario is DeferredScenario => "deferAdmission" in scenario && scenario.deferAdmission === true;

export type AdmissionStep = "created" | "paused" | "fixtures" | "seeded" | "delivered" | "resumed";
export interface AdmissionState {
  requestId: string;
  chat?: string;
  fixtures?: Record<string, string>;
  seededRev?: number;
  /** Each step with the time it finished, in the order it ran: the setup and admission order the run records. */
  order: { step: AdmissionStep; at: number }[];
}
export interface AdmissionIo {
  /** Creates the chat with no first message (POST api/threads with deferFirst) and returns its id. */
  createEmpty(): Promise<string>;
  pauseCheckIn(chat: string): Promise<void>;
  makeFixtures(chat: string): Promise<Record<string, string>>;
  /** Seeds the board and returns its rev. */
  seed(chat: string, fixtures: Record<string, string>): Promise<number>;
  /** Whether the chat's session already holds a user message, and whether it is this request's first message. */
  firstMessage(chat: string, requestId: string): Promise<"none" | "this" | "other">;
  deliver(chat: string, requestId: string): Promise<void>;
  resumeCheckIn(chat: string): Promise<void>;
  save(state: AdmissionState): void;
  now(): number;
}

const done = (state: AdmissionState, step: AdmissionStep): boolean => state.order.some(entry => entry.step === step);

export async function admit(state: AdmissionState, io: AdmissionIo): Promise<AdmissionState> {
  const mark = (step: AdmissionStep) => { state.order.push({ step, at: io.now() }); io.save(state); };
  if (!state.chat) { state.chat = await io.createEmpty(); mark("created"); }
  const chat = state.chat;
  if (!done(state, "paused")) { await io.pauseCheckIn(chat); mark("paused"); }
  const before = await io.firstMessage(chat, state.requestId);
  if (before === "other") throw new Error(`chat ${chat} already holds a first message this setup did not send, so it is no deferred admission`);
  if (!done(state, "seeded")) {
    // A head that has its first message is admitted: seeding now would rewrite a board it may have read or written.
    if (before === "this") throw new Error(`chat ${chat} got its first message before its board was seeded; this run cannot be repaired, so start a new run folder`);
    if (!state.fixtures) { state.fixtures = await io.makeFixtures(chat); mark("fixtures"); }
    state.seededRev = await io.seed(chat, state.fixtures);
    mark("seeded");
  }
  if (!done(state, "delivered")) {
    if (before === "none") {
      try { await io.deliver(chat, state.requestId); }
      catch (error) {
        // The prompt may have been accepted before the answer was lost: the session decides, and only a message that is not there is sent again.
        if (await io.firstMessage(chat, state.requestId) !== "this") throw error;
      }
    }
    mark("delivered");
  }
  if (!done(state, "resumed")) { await io.resumeCheckIn(chat); mark("resumed"); }
  return state;
}
