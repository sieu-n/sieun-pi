import { GO_WAIT_FIX, goWait, goWaitText, type GoWait } from "./chat-board.ts";

/*
 * A wait for leave sent to a job (c47). On 10-12 the board and the brief check held no wait yet, and VP of CI told its jobs by agent message
 * "Re-push the SAME object to a fresh ref (an -r2 name) only when I forward Fable's 'ON STAGING' word". The owner then wrote "NEVER wait for
 * something, or ask for my permission to push to Github etc.". After the board and the brief check refused such waits (c709ef0), on 10-12 and
 * 10-13 the chats still sent them to jobs: "No push until I relay Fable's go.", "Wait for my relay of Fable's go.", "push them after I relay
 * Fable's go". A sentence counts when it tells the job to hold (HOLD) and names a wait for leave (`goWait`); a report of what another thread
 * said ("Fable's word: the 06:03Z cancels were ...") or an "OK," reply does not.
 */
const HOLD = /^\s*(?:hold|wait)\b|\b(?:hold\s+(?:until|for|off|it|them|your|the\s+push)|waits?\s+(?:for|until)|until|no\s+push(?:es)?|(?:don['\u2019]?t|do\s+not)\s+push|only\s+(?:at|after|when|once)|(?:after|when|once)\s+I\s+(?:relay|forward|pass)|once\s+the\s+hold\s+lifts)\b/i;

/** The first sentence of an agent message to a job that holds the job for another thread's go, word or slot, or for the owner's ok on a push. */
export function steerWait(text: string): GoWait | null {
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    const wait = HOLD.test(sentence) ? goWait(sentence) : null;
    if (wait) return wait;
  }
  return null;
}

/** The note for a sent agent message that holds a job (`steerWait`), null when it holds none. The message goes out either way. */
export function steerWaitNote(text: string): string | null {
  const wait = steerWait(text);
  return wait ? `Sent, with a note (c47): this message tells your job to wait. It ${goWaitText(wait)}. ${GO_WAIT_FIX} Send the job a follow-up that tells it to take that action now.` : null;
}
