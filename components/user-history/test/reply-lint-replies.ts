/**
 * Real owner-facing replies, verbatim, with the owner's message each answered: the developer environment VP chat (01a1164b) and the VP of CI
 * chat (01a1180e), 2026-10-09. The owner corrected the first two ("두번째 단계가 뭐고 pi server가 뭘계산한다는거야 unslop", "아오씨발 뭔 개소리야
 * /skill:unslop"). The slop ones must fail the reply lint, the clean ones must pass it.
 */
export interface RealReply { chat: string; at: string; owner: string; reply: string }

export const SLOP_REPLIES: Record<string, RealReply> = {
  "two stages": { chat: "developer environment VP", at: "2026-10-09T14:25:39Z",
    owner: "그럼 바로 하나 반박할게요. \"check-in 코드 전부 삭제\"는 좀 과해요. 오늘 라이브된 step 분류와 fan-out 로직까지 날아가요. 중복된 duty runner랑 hourly 경로만 지우고, 분류 로직은 새 check-in으로 옮기는 게 나아요. 이렇게 갈까요?\n\n이거 얘기하자, functionally how does `check in` and `duties` work? 그냥 sieun-pi에서 프롬프트 뭉텅이 보내는거야?",
    reply: "네, 거의 맞아요. 두 단계로 돌아가요.\n\n1. **코드 체크.** check-in은 15분마다, Chat health는 매일 23:07에 sieun-pi 서버가 직접 계산해요. 보드를 읽어서 step을 분류하고 지표를 세요. 여기까지는 모델 호출이 없어요.\n2. **프롬프트.** 할 일이 있을 때만 결과를 `[check-in]` 메시지로 만들어 chat에 보내요. 실제 처리는 모델이 그 프롬프트를 읽고 해요.\n\n그래서 찾아내는 건 코드라 정확한데, 처리하는 건 모델 몫이라 무시하거나 대충 넘어갈 수 있어요. 지금 놓치는 문제는 대부분 이 두 번째 단계에서 생겨요." },
  "built-in duty": { chat: "developer environment VP", at: "2026-10-09T14:31:22Z",
    owner: "그래서 결국 지금 작업하고 있는거 결과는 check in 없애는거지 별도코드는 그리고 all chats will have an un-deletable duty that checks chat health?",
    reply: "첫 번째는 맞아요. 별도로 있던 check-in 코드는 없어지고, check-in은 모든 chat에 기본으로 들어가는 duty가 돼요. 지울 수 없고 Duties 카드에도 안 보여요.\n\n두 번째는 아니에요. 그 기본 duty가 하는 일은 보드 관리예요. Chat health는 지금처럼 이 chat에서만 하루 한 번 돌면서 전체 chat을 점검해요. chat마다 따로 돌리면 같은 점검을 10번 하게 돼서 저는 반대예요." },
  "fan-out logic": { chat: "developer environment VP", at: "2026-10-09T14:24:28Z",
    owner: "그 내가 뭘 모른다고 생각하거나 unorthodox한걸 하면 반박해도 돼. security관련ㅁ된건 개지랄 잘하던데 발작버튼 ㅋㅋ \n충분히 왔다갔다 해도 좋아 오히려 더 좋아",
    reply: "좋아요, 이제부터 어떤 주제든 그렇게 할게요. 모든 chat이 다음 턴부터 따르도록 corrections에 기록했고, brief에도 넣으라고 [realtime layer](thread:01a0fd18-88e0-7168-8e3b-b0bc53da3610)에 보냈어요.\n\n그럼 바로 하나 반박할게요. \"check-in 코드 전부 삭제\"는 좀 과해요. 오늘 라이브된 step 분류와 fan-out 로직까지 날아가요. 중복된 duty runner랑 hourly 경로만 지우고, 분류 로직은 새 check-in으로 옮기는 게 나아요. 이렇게 갈까요?" },
  "ledger labels": { chat: "developer environment VP", at: "2026-10-09T13:09:59Z",
    owner: "and if i correct you like this, this should NEVER happen the next day, or more than 2 days worst",
    reply: "Agreed. Today a correction can sit in one chat's notes and never reach the code, so it comes back. I've asked the realtime layer to build three things:\n- **Ledger:** every correction is saved the same turn, and every chat loads the list on its next turn.\n- **Health check:** the daily Chat health run counts repeated corrections, with a target of zero, and fixes repeats in code.\n- **Backfill:** this week's corrections go into the ledger now. p186" },
  "check-in job labels": { chat: "developer environment VP", at: "2026-10-09T13:09:36Z",
    owner: "FUCK i think this is also issue with subagent and context and laziness no? what do you think should be changed in the check in? it should (not explicitly) but spawn subagents to see different things, not the main agent sequentially checking. one guy do checklist, one guy nudges, communicates, ... this is just an example, the Job agent should dynamically map jobs",
    reply: "Yes, agreed. My check-ins run every open step in one context, take the board's own notes at face value, and get lazy. That's how the /sieun goal stayed open after it was live, and how the Mac load work stayed here after you said to hand it off.\n\nThe fix I sent to the realtime layer:\n- **Check-in turn:** only decides what needs doing.\n- **Real work:** goes to one check-in job, which picks its own helpers based on what it finds. For example, one checks steps against reality, one chases stale threads, and one catches work that belongs to another thread.\n- **Quiet ticks:** start nothing, so cost stays down. p184" },
  "standing duty bullets": { chat: "VP of CI", at: "2026-10-09T14:20:41Z",
    owner: "and for previous message you will create a duty right?",
    reply: "Yes, I added it to the board as a standing duty: 50 agents ship code without waiting on CI, and every land rule holds. It has four steps:\n- [ci efficiency audit](job:ci efficiency audit) finds the waste and ranks it by minutes saved per day.\n- Each problem it finds gets its own fix job, with review, a test push and a land.\n- At every check-in I clear whatever is blocking the queue.\n- To call it done, a commit has to reach staging in under 1 h at the median, for a full week." },
  "pro bullets": { chat: "VP of CI", at: "2026-10-09T14:09:13Z",
    owner: "how is ci doing so far?",
    reply: "Pro isn't on yet. GitHub still blocks the Pro-only repo rules ([github pro status check](job:github pro status check)), so we stay on the Oct 12 plan.\n\nCI is okay but busy:\n- Land 29's CI is running.\n- The light runners have 7 jobs queued, the oldest waiting 28 min.\n- Heavy jobs wait about 1 min on a typical run, up to 17 min on slow ones.\n- verify-dev usually takes 18 min.\n\nOur first batch goes at about 16:00Z." },
};

export const CLEAN_REPLIES: Record<string, RealReply> = {
  "clean later this week": { chat: "VP of CI", at: "2026-10-09T14:03:45Z",
    owner: "[board] Owner chose \"Yes, but later this week\" for \"Prod key lock plan is fully approved. You buy GitHub Pro ($4/month), make a lim…\"",
    reply: "Got it, later this week. On Oct 12 I'll suggest a time, and [prod key lock plan](job:prod key lock plan) will first recheck its patches against the latest code. The PRs-to-staging pilot moves back with it." },
  "clean pro check": { chat: "VP of CI", at: "2026-10-09T14:08:54Z",
    owner: "wait i might've bought it? check but pass if not.",
    reply: "I started [github pro status check](job:github pro status check). It reads the account plan and tries one Pro-only page on the repo, and it changes nothing. If Pro turns out to be active, I'll move the key lock forward. If not, we wait for Oct 12 as planned." },
  "clean live": { chat: "developer environment VP", at: "2026-10-09T13:07:24Z",
    owner: "p26 virev.ai/sieun matches the sieun-pi usage UI, with live tok/s on the overview 8 of 9 done\n\nthis is out already no?",
    reply: "Yes, it's live on virev.ai, and I've closed it on the board. The only thing left is the Korean hour labels fix, which ships with the next promote. I moved that to its own small item and asked the release owner when that promote happens. p183" },
  "clean ops guy": { chat: "developer environment VP", at: "2026-10-09T13:07:10Z",
    owner: "Mac load -> didn't i tell to delegate",
    reply: "Ops guy confirmed the Mac load hand-off. The goal is now on its board, and it starts the working-day check on 10-10 at 00:00Z. That step left our plan when I handed it over, so the board needs no change." },
  "clean duty lossless": { chat: "developer environment VP", at: "2026-10-09T14:30:10Z",
    owner: "lossless meaning fold check in into duties lossless",
    reply: "네, check-in을 duty로 옮겨도 잃는 거 없이 가능해요. 다만 지금 duty 구조 그대로는 안 돼요. 지금 duty는 정해진 시간에만 돌거든요.\n\ncheck-in은 job이 끝나거나 멈춰도 바로 깨어나요. chat 헤더에서 주기를 바꾸거나 멈추는 것도 되고요. 그래서 duty에 이 두 가지를 넣으라고 [realtime layer](thread:01a0fd18-88e0-7168-8e3b-b0bc53da3610)에 보냈어요. 잃는 게 없다는 건 오늘 check-in 기록을 새 duty로 다시 돌려서, 같은 결과가 나오는지 테스트로 확인해요." },
  "clean flow": { chat: "VP of CI", at: "2026-10-09T14:13:26Z",
    owner: "so for the procedure is it reasonable or standard? \nit's \n(agent works on shit) (during this agent calls verify-dev)-> push to dev branch -> ci automatically runs checks -> attempt merge by creating pr to staging -> ci runs proper checks tests -> merged to staging -> promote has some checks too? promote is more like github action button click?\n\naccording to my understanding is it?",
    reply: "Mostly. Your flow is the standard one, but ours differs today:\n\n```mermaid\nflowchart LR\n  A[Agent commits locally] --> B[ci/ test branch, one at a time]\n  B --> C[Release owner pushes dev and lands]\n  C --> D[Full CI rerun, then staging]\n  D --> E[Promote: button with gates] --> F[Prod]\n```\n\n- No PRs yet. That's planned, after the key lock.\n- Only one pusher.\n- Promote is a manual button with gates for now. It becomes automatic after its shadow week." },
};
