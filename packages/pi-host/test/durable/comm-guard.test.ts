/**
 * `relay-line.ts` and `comm-guard.ts` on the agent posts of apps/chat's room logs (11-03): the relay lines are marked with their kind, and
 * the results and answers beside them are not; a comm thread's post after its hand-over in the same turn is refused unless it asks a question,
 * hand-over words are refused on any turn, and progress words unless the owner started the turn with a question.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { asks, asksTable, commPostRefusal, CRAMMED_MARK, crammedLine, crammedResent, hasTable, relayEdit, RELAY_EDIT_MARK, tableResent, TABLE_MARK, turnAsked, turnAskedTable, turnStartedAt } from "../../src/durable/comm-guard.ts";
import { relayWords } from "../../src/durable/relay-line.ts";

/** Agent posts from the room logs that relay the agent's own work, with the kind each one reads as. */
const RELAYS: [string, "handoff" | "progress"][] = [
  ["The vent thread is now listing every panel, including Vent, admin, Grafana and the rest, with its data, backend and a tested login, on one wiki page.", "progress"],
  ["The agent factory work thread is building all five now, including the wip emoji, auto-tagging channel members and @ for agents outside the channel.", "progress"],
  ["The agent factory work thread is fixing all three on live :5184, and it will send a shot of gpt guy's panel when done.", "handoff"],
  ["The job [agents list shows agents only](job:agents list shows agents only) is fixing it so pickers list only agents and jobs stay inside their agent (p29).", "progress"],
  ["The job tailscale gate design is mapping each screen and writing the design page for p1.", "progress"],
  ["Got it on the health light, real traffic only and grey when there's none. I passed that to the job vent integration health.", "handoff"],
  ["I started 4 jobs that run in parallel: vent landing and deploy, vent caller cutover, vent webhooks and vent console.", "handoff"],
  ["It should print 6 lines. The work thread is running it now, and I'll confirm the real count when it finishes.", "handoff"],
  ["I'll post the wiki link here once the list is done.", "handoff"],
  ["I asked the vent work thread to build the full list.", "handoff"],
  ["I sent the task to the work thread.", "handoff"],
  ["On it.", "handoff"],
  ["The catch is Chrome shares one Instagram login, so your open Instagram tabs would flip accounts for those seconds. A job is testing whether that can be avoided.", "progress"],
  ["지금 konti domain finish가 그 로그인으로 직접 들어가서 konti.bot 리다이렉트 걸고, 끝나면 결과만 알려드릴게요.", "handoff"],
];

/** Results and answers from the same logs, which no check may mark. */
const RESULTS = [
  "Vent's console is at vent.virev.ai for prod and staging-vent.virev.ai for staging, but I don't have each panel's sign-in on hand yet.",
  "Makes sense, Accounts moves into a tab under Settings and leaves the top bar.",
  "gpt guy's panel is fixed on :5184, and he shows Idle now because his GPT runs work again.",
  "The @ list and the Agents page now show only agent factory and vent, with each job inside its agent under a short title.",
  "Plan lives in the Convex table searchCreditBalances, one row per org with plan, included pool, Stripe subscription id and status, and period dates.",
  "The loop finished and printed 6 lines, so result.txt now says 6.",
  "summaries.md is done, with one line for each of the 20 files.",
  "Each screen gets its own Tailscale address on us-metal01, and Grafana and Vent log you in from your Tailscale identity.",
  "Should I start a job to move these dashboards behind Tailscale now?",
  "Release 21 fixed the frozen Vercel and Railway panels, so the small prod Vent update on t15 isn't needed.",
  "Removed 120 committed leftovers plus 1,546 local junk files from the checkout.",
  "Stopped. The Railway job and its helpers are shut down, and I sent the Railway Breach thread where things stand.",
];

/** On 11-03, an answer to the owner's status question (ch_14ad7a70 p39 and p40), which may go out. */
const ANSWERED: [string, string] = ["are you working on Meilisearch then?", "Yes, the search job (p56) is timing Meilisearch against our fixed SQLite search on the real data now."];

test("the relay lines of the room logs read as hand-over or progress, and the results and answers beside them read as neither", () => {
  for (const [text, kind] of RELAYS) assert.equal(relayWords(text)?.kind, kind, text);
  for (const text of RESULTS) assert.equal(relayWords(text), undefined, text);
});

test("a comm thread's post after its hand-over in the turn goes out unless it relays the hand-over (owner, #sw-factory-build p159, c234)", () => {
  const handed = { owner: true, asked: false, handed: true };
  assert.equal(commPostRefusal("proposal coming as one page, with my pick for where the data lives and the few calls only you can make", handed), undefined, "one plain line on what he gets goes out");
  assert.equal(commPostRefusal("Makes sense, Accounts moves into a tab under Settings and leaves the top bar.", handed), undefined);
  assert.equal(commPostRefusal("Which repo should the panel list cover, auto-sns-agent only or every repo?", handed), undefined);
  assert.match(commPostRefusal(RELAYS[0]![0], handed)!, /reports the hand-over you made in this turn/);
  assert.match(commPostRefusal("The vent thread is listing the panels now, want the logins too?", handed)!, /^Not sent: "[^"]+" reports the hand-over/);
  assert.match(commPostRefusal("- [ ] the vent thread is listing the panels now", handed)!, /reports the hand-over/, "relay words still refuse a checklist");
});

test("hand-over words are refused on any turn, and progress words unless the owner started the turn with a question", () => {
  const owner = { owner: true, asked: false, handed: false };
  const asked = { owner: true, asked: true, handed: false };
  const notice = { owner: false, asked: true, handed: false };
  assert.match(commPostRefusal("I'll post the wiki link here once the list is done.", asked)!, /^Not sent: "I'll post the wiki link here once" announces a hand-over/);
  assert.equal(commPostRefusal("summaries.md isn't written yet. The work thread is reading threads.ts, the last of the 20 files.", asked), undefined);
  assert.equal(commPostRefusal(ANSWERED[1], { ...owner, asked: asks(ANSWERED[0]) }), undefined);
  assert.match(commPostRefusal(RELAYS.find(([text]) => text.startsWith("The catch is Chrome"))![0], { ...owner, asked: asks("proxy가 아니라 근데 Client browser에서") })!,
    /^Not sent: "job is testing" is progress on work still going/);
  assert.match(commPostRefusal("The work thread is reading threads.ts, the last of the 20 files.", notice)!, /is progress on work still going/);
  assert.equal(commPostRefusal("summaries.md is done, with one line for each of the 20 files.", notice), undefined);
});

/** On 11-24, the texts the agent factory work thread edited into #dev-app-search-prospect p67 and #dev-crawler p2, and p67 as first posted. */
const EDITED_IN = [
  "Crawler guy is set up in this room and has the media move off GeoNode.\n\n- It took over the earlier job's work from its last commit, so nothing is built twice.\n- Its job is changing the fetch path to Instagram's CDN now.\n- It posts the GeoNode media bytes from before and after in this thread.",
  "Crawler guy is live as the crawler's maintenance and development agent. Talk to it here or in its DM.\n\n- It takes every new crawler ask from today: crawler-v3 lanes, Sirocco, proxies and their spend, and image and video downloads.\n- Its first job is moving media off GeoNode, and it is running.",
];
const POSTED = "Crawler guy coming as its own agent in this room, set up from the Crawler VP chat's brief and your proxy rules, with the media move off GeoNode as its first job.";

test("an edit with progress words is held once, one with hand-over words is refused each time, and a result edit goes out", () => {
  for (const text of EDITED_IN) {
    const held = new Set<string>();
    assert.match(relayEdit(text, held)!, new RegExp(`^${RELAY_EDIT_MARK}: "job is (?:changing|moving)" is progress on work still going`), text);
    assert.equal(relayEdit(text, held), undefined, "the very same text sent again edits it");
  }
  const held = new Set<string>();
  const handoff = "Crawler guy is set up in this room.\n- I'll post the GeoNode media bytes here once the move is done.";
  assert.match(relayEdit(handoff, held)!, /announces a hand-over or a result to come/);
  assert.match(relayEdit(handoff, held)!, /announces a hand-over or a result to come/);
  assert.equal(relayEdit(POSTED, held), undefined);
  assert.equal(relayEdit("Crawler guy is set up in this room.\n- Images and videos load straight from Instagram's CDN since 05:23 KST.\n- GeoNode carried 0 media bytes on 11-22 and 11-23.", held), undefined);
});

test("an owner post asks when a line ends in a question, and a statement or a question mid-line before a task does not", () => {
  for (const text of ["are you working on Meilisearch then?", "done??? @agent factory", "remove zerobounce . \n\nwhat's slack-sales?\ntheres a whole bunch", "이거 어때", "다 끝났나요", "지금 할까\n", "로그인 됐니~"]) {
    assert.equal(asks(text), true, text);
  }
  for (const text of ["proxy가 아니라 근데 Client browser에서", "ㅇㅇ 그렇게 좀 해줘.", "Delete 안보임", "@agent factory  이딴건 말하면 안되겠지? 계속 usage pattern 감시하고, 실제 slack처럼 동작하도록 해."]) {
    assert.equal(asks(text), false, text);
  }
});

test("the turn starts at the newest owner or agent message before the call", () => {
  assert.equal(turnStartedAt([{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }, { role: "custom", timestamp: 3 }, { role: "toolResult", timestamp: 4 }, { role: "assistant", timestamp: 5 }]), 3);
  assert.equal(turnStartedAt([{ role: "assistant", timestamp: 2 }]), undefined);
  assert.equal(turnAsked([{ role: "user", content: "how far is the list?" }, { role: "assistant", content: [{ type: "text", text: "On it?" }] }]), true);
  assert.equal(turnAsked([{ role: "user", content: "how far?" }, { role: "custom", content: [{ type: "text", text: "reading threads.ts" }] }]), false);
  assert.equal(turnAsked([{ role: "user", content: [{ type: "image" }, { type: "text", text: "이거 어때" }] }]), true);
});

/** Search product, misc.'s answer to "what is our definitive catalog now?" in #dev-search-general (p16, 11-20), cut to two rows. */
const CATALOG = "Sorry, here is the setup now, five pieces over Google's 211 guides.\n\n| Piece | Where it lives | Who reads it | What it says |\n|---|---|---|---|\n" +
  "| Prime skill | sieun-pi `skills/modern-web-guidance` | every agent session lists it | Google's flow |\n| CLI | installed on us-metal02 | both skills | `search`, `retrieve` |";

test("a post with a table is held once unless the post that started the turn asks for one, and the very same text sent again goes out", () => {
  const owner = { owner: true, asked: true, handed: false };
  assert.equal(hasTable(CATALOG), true);
  assert.equal(hasTable(":---|---: |\n| a | b |"), false);
  assert.equal(hasTable("5 pieces: google's skill, a repo copy, and the CLI. paths → [skill catalog](wiki:agents/x/catalog.html)"), false);
  assert.match(commPostRefusal(CATALOG, owner)!, /^Not sent, it holds a table nobody asked for[\s\S]*wiki\.write[\s\S]*very same text again/);
  assert.equal(commPostRefusal(CATALOG, { ...owner, tableAsked: true }), undefined);
  assert.equal(commPostRefusal(CATALOG, { ...owner, tableResent: true }), undefined);
  assert.equal(commPostRefusal("nope 😬 the table gets cut off in the thread", owner), undefined);
  const call = (id: string, text: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }] });
  const held = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `${TABLE_MARK}, and a room reads like Slack` }] });
  assert.equal(tableResent([{ role: "user", content: "catalog?" }, call("a", CATALOG), held("a"), call("b", CATALOG)], CATALOG), true);
  assert.equal(tableResent([{ role: "user", content: "catalog?" }, call("a", CATALOG)], CATALOG), false);
  assert.equal(tableResent([call("a", CATALOG), held("a"), { role: "user", content: "and now?" }, call("b", CATALOG)], CATALOG), false, "a new turn holds it again");
  for (const text of ["can you put it in a table?", "표로 정리해줘", "show it as a table"]) assert.equal(asksTable(text), true, text);
  // c225: a question how a setup or catalog is set up gets one table of its pieces, so it counts as asking for one.
  for (const text of ["what is our definitive catalog now after this update?", "what pieces make up the skill setup agents get in this repo?", "is the mcp configured properly?", "스킬 설정 어떻게 돼있어?"]) assert.equal(asksTable(text), true, text);
  for (const text of ["발표 자료 대표 이미지 표시해줘", "is it stable?", "is this checkout on main right now?"]) assert.equal(asksTable(text), false, text);
  const header = "[#dev-search-general · post 15 from You (owner) · hops 0]\n\n";
  assert.equal(turnAskedTable([{ role: "user", content: `${header}what pieces make up the skill?\n\n(thread so far)\n11 agent: | a | b |\n|---|---|\nput it in a table` }]), false);
  assert.equal(turnAskedTable([{ role: "user", content: `${header}put it in a table please\n\n(thread so far)\n11 agent: ok` }]), true);
});

/** Search product, misc.'s answer to the owner's cost ask in #dev-app-search-prospect (p13, 11-20), under which he wrote "slop slop slop" (p33). */
const P13 = "breathing costs about $1,850-2,210 a month on GeoNode's 200 Mbps plan, almost all of it the flat GeoNode fee. one tracked brand adds under 2 cents a month. " +
  "the demo load alone would fit a $148.50 metered GeoNode plan, about $200-560 a month total → [breathing cost](https://us-metal02-dev.tail0c093d.ts.net:5184/wiki/agents/search-product-misc/jobs/2026/11/20/1417-breathing-cost-page/breathing-cost.html)";
/** p12 of the same thread, one point in two sentences. */
const P12 = "> is our API serving?\n\nyes, 175 of 178 routes work, and 11 of 11 real customer calls just returned data. but every working route now goes out from the prod server's own IPs too, " +
  "details → [crawl api serving](https://us-metal02-dev.tail0c093d.ts.net:5184/wiki/agents/search-product-misc/jobs/2026/11/20/1415-crawl-api-route-logs/crawl-api-serving.html)";

test("a post that crams several results on one line is held once, and the very same text sent again goes out", () => {
  const owner = { owner: true, asked: true, handed: false };
  assert.match(commPostRefusal(P13, owner)!, /^Not sent, one line crams several results: "breathing costs[\s\S]*`- ` bullet[\s\S]*very same text again/);
  assert.equal(commPostRefusal(P13, { ...owner, crammedResent: true }), undefined);
  assert.equal(commPostRefusal(P12, owner), undefined, "a one-point answer of two sentences goes out");
  assert.equal(crammedLine("yep, all 18 pass with 0 failures, across reactions.test.ts (7), emoji.test.ts (2) and for-me.test.ts (9) under apps/chat/test/server."),
    "yep, all 18 pass with 0 failures, across reactions.test.ts (7), emoji.test.ts (2) and for-me.test.ts (9) under apps/chat/test/server.", "three numbered clauses in one sentence");
  const bulleted = "breathing costs about $1,850-2,210 a month, almost all of it the GeoNode fee\n- one tracked brand adds under 2 cents a month\n" +
    "- the demo load alone fits a $148.50 metered plan, about $200-560 a month\n- detail → [breathing cost](wiki:agents/search-product-misc/breathing-cost.html)";
  assert.equal(commPostRefusal(bulleted, owner), undefined, "the same numbers as an answer over bullets go out");
  for (const text of [
    "fixed in 8e8b7ef7 on 11-21 at 16:05, see p159 and ch_4c388a00/p12 on :5184.",
    "newest was v0.2.25, published today at 09:18 KST (00:18 UTC). the oldest is v0.2.6",
    "yes, all pass, reactions 7/7 and `emoji.test.ts` 2 of 2.",
    "```\na. b. c. 1, 2, 3\n```\nyes, it runs.",
  ]) assert.equal(crammedLine(text), undefined, text);
  const call = (id: string, text: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }] });
  const held = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `${CRAMMED_MARK}: "breathing costs"` }] });
  assert.equal(crammedResent([{ role: "user", content: "cost?" }, call("a", P13), held("a"), call("b", P13)], P13), true);
  assert.equal(crammedResent([{ role: "user", content: "cost?" }, call("a", P13), held("a")], `${P13} edited`), false, "a changed text is checked again");
  assert.equal(crammedResent([call("a", P13), held("a"), { role: "user", content: "and now?" }, call("b", P13)], P13), false, "a new turn holds it again");
  assert.equal(tableResent([{ role: "user", content: "cost?" }, call("a", P13), held("a"), call("b", P13)], P13), false, "a crammed hold is no table hold");
});
