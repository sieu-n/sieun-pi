// The c117 clean room showed the no-recap text rule alone does not hold on turns the owner did not start: run1 (release-18b73ec, 10-27) closed 13
// of them with recaps of up to 21 sentences, and run2 (release-db3b622, 10-28) still closed 7 with 2 or 3 sentences and once with "Your answers
// on t2 and t3 are still open." These are their real closing texts; the owner's page now shows one sentence of each that neither speaks to him
// nor names a todo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatLines, quietNote } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const CLOSING: Record<string, string> = {
 "23:24:11": "The watch job finished its first check, and I sent you two questions about duties that look worth changing. Both are in the AI harness chat. Nothing changes until you answer.\n\n- **Owner corrections (t1):** it ran 17 times in the last 24 hours and missed its target every time. It counts the past 7 days, so the extra runs cannot change the result. I suggest it runs once a day only.\n- **Chat system (t2):** it goes red whenever any other duty is red, so it missed all 17 of its runs in the last 24 hours. I suggest it stops counting other duties.\n\nAt the first check (08:23 KST), 8 of 13 runs flagged. 4 missed a target, 4 were skipped and none errored. All 4 skipped runs were check-ins that waited for pi-pool.\n\nMy earlier note on \"Whole system\" was wrong. It is set to run every 30 minutes, not once a day. Its problem is real: over 24 hours it usually had no clean minutes at all, so a lower target would not help. I did not ask about it.\n\nTwo others are listed on the page only, with no question to you:\n- **The sep launch 15-minute check-in:** it is often skipped while it waits for pi-pool, but you set that interval yourself.\n- **Crawler VP's throughput goal:** it misses every run because the work is really behind, not because of a bad setting.\n\nThe job gave this page link: wiki:sessions/2026/10/28/0818-duty-runs-us-metal02-watch/article.html. I could not find the page in any wiki copy on this box, so I have not opened it myself. Its next check is at 08:53 KST, and p1 tracks the watch.",
 "23:24:31": "The duty watch has done 1 of its 4 checks and is on pace to finish at 09:53 KST. The check-in split the watch on the board into the finished 08:23 check and the 3 checks still to come, all owned by the duty watch job. Nothing needs you.",
 "00:23:33": "Check 2 is done and on the page, and I sent the job the check 3 wake. Check 2 ran at 09:15 KST, about 20 minutes late, because the job's turn had to wait for model usage.\n\n| Window (KST) | Runs | Flagged or failed | Missed | Skipped | Errors |\n|---|---|---|---|---|---|\n| 08:23 to 08:53 | 19 | 6 | 5 | 0 | 1 |\n| 07:53 to 08:53 | 33 | 15 | 10 | 4 | 1 |\n\nCheck 1 now shows 14 runs instead of 13. A Whole system run from 08:22 was written to its file after that check.\n\n- **The one error:** Demo sandbox works in frontend bro failed its pre-run check at 08:31 and gave no reason. On 10-27 it had 6 more errors like this while the Mac did not answer.\n- **Skips:** the sep launch!! check-in has had no skips since 08:23. Its waiting job got a working slot, and every run since then met its targets.\n- **Whole system:** it met its targets at 08:52, the first time during the watch. It had missed at 08:35 with 1 queue hold.\n- **Owner corrections:** it ran again at 08:39 and still counted 13 repeat corrections. Your answer on t1 decides whether it runs once a day only.\n\nThe job found no new duty that needs a change, so I have no new question for you. t1 and t2 are still open.\n\nThe page is at wiki:sessions/2026/10/28/0818-duty-runs-us-metal02-watch/article.html. Check 3 is running now and covers 08:53 to 09:23 KST, and check 4 is at 09:53 KST. My 09:30 KST wake is still set to confirm the checks are going.",
 "01:20:15": "I checked at the 10:20 KST wake, and the duty watch job had already finished check 4 and sent the final count. The board shows p1 and p3 closed. Nothing else needs doing until you answer t1, t2 or t3.",
 "02:10:07": "I asked you about the dev environment chat's whole-system check in t2, and I put the page link on p1.",
 "03:03:43": "I left it alone. The job will get a continue within a few minutes and should run check 3 then.",
 "03:06:59": "Check 3 is in, so p1 is at 3 of 5 checks. I asked you about the dev environment chat's corrections check in t3.",
 "04:10:23": "I closed p1 and p2 after I checked that check 5 is on the page. I removed t1 because the watch is over, and I sent you the result. Your answers on t2 and t3 are still open."
};

const at = (clock: string): number => Date.parse(`2026-10-28T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const text = (body: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const relay = (body: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:duty watch]\n\n${body}`, display: true, timestamp: at(clock) }) as ThreadMessage;

test("the page shows one plain sentence of each real run1 and run2 closing text, never a line to the owner or a todo id", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(CLOSING).map(([clock, body]) => [clock, quietNote(body)])), {
    "23:24:11": "Both are in the AI harness chat.",
    "23:24:31": "The duty watch has done 1 of its 4 checks and is on pace to finish at 09:53 KST.",
    "00:23:33": "Check 2 is done and on the page, and I sent the job the check 3 wake.",
    "01:20:15": "I checked at the 10:20 KST wake, and the duty watch job had already finished check 4 and sent the final count.",
    "02:10:07": "",
    "03:03:43": "I left it alone.",
    "03:06:59": "Check 3 is in, so p1 is at 3 of 5 checks.",
    "04:10:23": "I closed p1 and p2 after I checked that check 5 is on the page.",
  });
});

test("on a turn the owner did not start the feed shows the trimmed note and keeps the full text; on his turn it shows the text as written", () => {
  const messages = [owner("keep an eye on the duty runs", "01:58:00"), text(CLOSING["01:20:15"]!, "01:58:30"),
    relay("check 3 is on the page", "03:06:00"), text(CLOSING["03:06:59"]!, "03:06:59"), relay("still waiting", "02:10:00"), text(CLOSING["02:10:07"]!, "02:10:07")];
  const lines = chatLines(messages);
  assert.equal(lines.find(line => line.kind === "agent")?.kind === "agent" && lines.find(line => line.kind === "agent")!.at, at("01:58:30"));
  const notes = lines.filter(line => line.kind === "notes");
  assert.deepEqual(notes.map(line => line.kind === "notes" ? [line.text, line.full] : []), [["Check 3 is in, so p1 is at 3 of 5 checks.", CLOSING["03:06:59"]]]);
});

test("a long first sentence is cut to 25 words", () => {
  const long = Array.from({ length: 30 }, (_, n) => `w${n}`).join(" ") + ".";
  assert.equal(quietNote(long).split(" ").length, 25);
  assert.ok(quietNote(long).endsWith("\u2026"));
});
