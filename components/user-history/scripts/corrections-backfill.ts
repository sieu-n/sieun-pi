import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CorrectionLedger, parseCorrectionCall } from "../src/chat-corrections.ts";

/**
 * `node --import tsx scripts/corrections-backfill.ts [--data-dir <dir>]`: records the owner's corrections of 10-08 and 10-09 in
 * <data dir>/corrections.json, oldest first, through the same path as the chat's correction_add tool, so a later one on the same theme is a
 * repeat. Each entry quotes the owner's message from the chat transcript (a board answer keeps only the answer). Running it again changes
 * nothing: the same words are already recorded.
 */
export const BACKFILL: { at: string; chat: { id: string; name: string }; words: string; rule: string; theme: string; enforcedBy: string; ref: string }[] = [
  {
    "at": "2026-10-08T10:26:30.565Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "it starts to become illegible now, /unslop /unslop /unslop . should be readable straight as a text block think of it.",
    "rule": "Replies read like a coworker's text message: short, casual, plain sentences that read straight through, no report formatting or label openers.",
    "theme": "reply text message plain casual formatting",
    "enforcedBy": "brief",
    "ref": "22c3ba4"
  },
  {
    "at": "2026-10-08T10:29:32.384Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "also even if i say i Korean always message in English never in Korean unless for like translation in which it's obvious use case",
    "rule": "Everything sent to another agent is in English; after the owner's exact words, say in English what they mean.",
    "theme": "english agent message translate korean",
    "enforcedBy": "brief",
    "ref": "22c3ba4"
  },
  {
    "at": "2026-10-08T20:10:14.733Z",
    "chat": {
      "id": "01a11bd7-072f-7591-ad1d-f123c276cde5",
      "name": "***launch main bro***"
    },
    "words": "how the hell do i see this?",
    "rule": "When the owner must review or pick a UI variant, put the link and one screenshot per variant inline in the chat message.",
    "theme": "ui variant pick screenshot inline",
    "enforcedBy": "brief",
    "ref": "3f446bc"
  },
  {
    "at": "2026-10-09T10:12:31.466Z",
    "chat": {
      "id": "01a11af8-962e-773d-a19a-ee4104011987",
      "name": "ops guy (+observability)"
    },
    "words": "ran vercel login, next time for these can you consult Aside and login auth yourself? most will pass with Google or Github oauth",
    "rule": "A CLI or service login is finished by the chat or its job in the owner's Aside browser with Google or GitHub sign-in; ask only when no OAuth path works.",
    "theme": "cli login aside oauth browser",
    "enforcedBy": "brief",
    "ref": "bf98389"
  },
  {
    "at": "2026-10-09T10:22:56.394Z",
    "chat": {
      "id": "01a1180e-6567-747f-bf44-452520ebdd1b",
      "name": "VP of CI"
    },
    "words": "unslop, you are talking so much slop. \n\ni said explain github pro where the hell that this go? you didn't track this in todo?",
    "rule": "An explanation the owner asks for is an owner todo until done; the article link goes in the reply and in that todo.",
    "theme": "explanation article link todo reply",
    "enforcedBy": "brief",
    "ref": "510c331"
  },
  {
    "at": "2026-10-09T10:27:59.246Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "look, eventually on it's own all threads should resolve to \n\nsome items in FOR YOU\nTODO all cleared, only ones blocked by FOR YOU remaining. \n\nmanage stale shit, properly nudge push through, ... is you (chat agent's responsiblitity). and since your job is to make this work on it's own automagically via the right prompts logic add to duties, .. \n\n\ntodo must be suuuper up to date lauer (i know it need active management, but the child agent must try it's best to return callback when done, main thread and check-in should try it's best to keep it up to date) \nit doesn't seem like it has been working at all.",
    "rule": "Keep the board current and push every step through: For you holds only the owner's asks, stale steps get chased, jobs report back.",
    "theme": "board current todo push stale chase",
    "enforcedBy": "code",
    "ref": "31222b9"
  },
  {
    "at": "2026-10-09T10:51:38.402Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "also delegate all M1/M2 air management things to Ops guy too",
    "rule": "Machine management (the M1 Air, the M2 Air and this Mac's load) belongs to ops guy; forward it there and never run it here.",
    "theme": "mac machine load delegate ops guy",
    "enforcedBy": "brief",
    "ref": "VP board notes s76 and s89 only; no brief or code rule"
  },
  {
    "at": "2026-10-09T10:54:24.257Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "then wipe it from our plan bro",
    "rule": "A step handed to another thread for good leaves this plan, with one scratch note naming the new owner.",
    "theme": "handoff step remove plan thread",
    "enforcedBy": "brief",
    "ref": "9953e20"
  },
  {
    "at": "2026-10-09T10:56:27.305Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "NO DON'T SHOW THIS RAWDOGG THIS IN MAIN THREAD, ANYTHING THAT SHOWS HERE MUST BE EXPLICIT CHAT MESSAGE THE VP AGENT DECIDES TO SEND.  but i just said i like the tendancy that agent mentions it alow",
    "rule": "Job reports stay folded in the feed; the chat sends a short message with the outcome and a job: link.",
    "theme": "job report folded feed link",
    "enforcedBy": "brief",
    "ref": "6052bad"
  },
  {
    "at": "2026-10-09T10:57:19.510Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "where the hell is the link?",
    "rule": "An explanation the owner asks for is an owner todo until done; the article link goes in the reply and in that todo.",
    "theme": "explanation article link todo",
    "enforcedBy": "brief",
    "ref": "510c331"
  },
  {
    "at": "2026-10-09T12:49:00.688Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "um the VP Chat thread having many goals is ok, but i meant to distribute it nicely to split Jobs with one goal, also that Job should split work to subagents. for example, for SEO thing, the Job can be \"do todays SEO iteration\" -> spawns subagents to do research, then one subagent each to draft EACH article. this is an especially good example bc telling Job thread to \"write 10 articles\", each article is super super sloppy and low quality, unlike with subagents. it's small detail but how llms and messages API behave. understand what i meant?",
    "rule": "One job per goal; a job gives each output item (an article, a page) its own subagent and checks their results.",
    "theme": "job goal subagent output item split",
    "enforcedBy": "brief",
    "ref": "586aa87"
  },
  {
    "at": "2026-10-09T13:05:27.222Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "are you sure this is up to date and you're pushing through?",
    "rule": "Keep the board current and push every step through.",
    "theme": "board current up to date push",
    "enforcedBy": "code",
    "ref": "31222b9"
  },
  {
    "at": "2026-10-09T13:06:51.466Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "Mac load -> didn't i tell to delegate",
    "rule": "This Mac's load goes to ops guy too.",
    "theme": "mac load delegate ops guy",
    "enforcedBy": "brief",
    "ref": "VP board note s89"
  },
  {
    "at": "2026-10-09T13:09:13.439Z",
    "chat": {
      "id": "01a1164b-4a2d-742d-b27a-82f086ed0200",
      "name": "AI harness developer environment VP"
    },
    "words": "FUCK i think this is also issue with subagent and context and laziness no? what do you think should be changed in the check in? it should (not explicitly) but spawn subagents to see different things, not the main agent sequentially checking. one guy do checklist, one guy nudges, communicates, ... this is just an example, the Job agent should dynamically map jobs",
    "rule": "A check-in fans out to a check-in job whose subagents each take one kind of check, not the chat checking every step in sequence.",
    "theme": "checkin fan out parallel checks",
    "enforcedBy": "code",
    "ref": "a0ab13c"
  },
  {
    "at": "2026-10-09T13:16:55.560Z",
    "chat": {
      "id": "01a115e2-9544-7204-b8db-8ce4d5319048",
      "name": "Crawler VP"
    },
    "words": "씨발 무슨job인지 말해줘야될거 아니니^^ look but the fundamental issue is the instruction right? assess why and feedback to AI harness developer environment VP",
    "rule": "Name every job and thread you mention by its exact name as a link (job:<name>, thread:<id>).",
    "theme": "name job thread mention link",
    "enforcedBy": "test",
    "ref": "294d8e4"
  }
];

export async function backfill(dataDir: string): Promise<Record<string, number>> {
  const ledger = new CorrectionLedger(dataDir);
  const counts: Record<string, number> = { added: 0, repeat: 0, known: 0 };
  for (const { at, chat, ...input } of [...BACKFILL].sort((a, b) => a.at.localeCompare(b.at))) {
    const outcome = await ledger.apply(parseCorrectionCall(input), chat, at);
    counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  }
  return counts;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const at = process.argv.indexOf("--data-dir");
  const dataDir = at >= 0 ? resolve(process.argv[at + 1] ?? "") : join(homedir(), ".prime/agent/browser-chat");
  process.stdout.write(`${JSON.stringify(await backfill(dataDir))} in ${join(dataDir, "corrections.json")}\n`);
}
