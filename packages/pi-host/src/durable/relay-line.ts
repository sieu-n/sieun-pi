/**
 * Words that mark a chat post as a relay of the agent's own work instead of a result: a hand-over announcement ("I passed it to the work
 * thread", "I'll post the link once it's done") or progress on work still going ("The vent thread is now listing every panel").
 *
 * The owner's words (#sw-factory-build, 11-03, msg mw02d0du) on vent's comm thread post "The vent thread is now listing every panel, including
 * Vent, admin, Grafana and the rest, with its data, backend and a tested login, on one wiki page.": "이딴건 말하면 안되겠지? ... 실제 slack처럼
 * 동작하도록 해. working indicator는 emoji response같은걸로". Of the 185 agent posts in apps/chat's room logs on 11-03, these words mark that
 * line, the agent factory comm thread's "The agent factory work thread is building all five now, ..." posted in reply to it, and the other
 * hand-over and progress lines listed in `test/durable/relay-line.test.ts`, and no result or answer there.
 *
 * `comm-guard.ts` refuses a comm thread's post with hand-over words on any turn and one with progress words on a turn the owner did not start
 * (a status question he asks gets its answer), and apps/chat's duty precheck `scripts/duties/relay-posts.ts` counts both in real rooms.
 */

/** Announces a hand-over, or a result that comes later. Never an answer, on any turn. */
const HANDOFF: readonly RegExp[] = [
  /\b(?:I|we)(?:['’]ve| have)? (?:just |now )?(?:asked|handed|passed|gave|forwarded|delegated|routed|kicked off|started|spun up|sent\b[^.?!\n]*?\bto)\b[^.?!\n]*\b(?:work thread|thread|jobs?)\b/i,
  /\b(?:I|we|it|they|the (?:\w+ )?(?:thread|job))(?:['’]ll| will) (?:post|send|share|report|tell you|let you know|confirm|update you|ping you|drop|reply)\b[^.?!\n]*\b(?:when|once|after|as soon as)\b/i,
  /^(?:on it|taken|working on it)\b/i,
  /(?:끝나면|완료되면|되는 대로)[^.?!\n]*(?:알려|공유|올려)드릴게요/,
];

/** Progress on work still going, told as the work thread's or a job's state. */
const PROGRESS: readonly RegExp[] = [
  /\b(?:work thread|(?:the |its |my |our )?\w+ thread|the job|jobs?)\b[^.?!\n]{0,120}?\b(?:is|are) (?:now |still |currently )?(?!done\b|finished\b|complete\b|live\b)(?:\w+ing)\b/i,
  /\b(?:work thread|thread|job|jobs)\b[^.?!\n]{0,120}?\b(?:is|are) (?:now )?(?:underway|under way|in progress|at work|on it)\b/i,
  /(?:작업|진행)\s?중(?:이에요|입니다|이야)/,
];

export type RelayKind = "handoff" | "progress";

/** The first relay words in `text`, with their kind: hand-over words first, since they never answer anything. */
export function relayWords(text: string): { kind: RelayKind; words: string } | undefined {
  for (const [kind, list] of [["handoff", HANDOFF], ["progress", PROGRESS]] as const) {
    for (const pattern of list) {
      const match = pattern.exec(text);
      if (match) return { kind, words: match[0] };
    }
  }
  return undefined;
}
