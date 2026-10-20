// Guards owner rule c48 (with c78): on 10-19 frontend bro's UI job briefs stopped naming the frontend design skill after 08:57Z, and at 17:14Z the
// owner repeated "it doens't do fat-as-fuck containers fix that ... also frontend design skill please". A job whose brief reads as UI work now
// gets the c48 line in its [corrections] block unless the brief names the frontend design skill and the shared components.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { jobLedgerPrompt, UI_RULE_LINE, uiRuleLine } from "../src/chat-corrections.ts";
import { deliverCorrections } from "../src/correction-delivery.ts";

// From frontend bro's 'dashboard first run' brief, 10-19 15:19Z, which named the shared components but not the frontend design skill.
const DASHBOARD_FIRST_RUN = "My read: work on Staging's Dashboards Home (home/dashboard-final) for two cases. Rules: one long-lived builder per part (the to-do card, " +
  "the bare-bones layout and empty states, the live stream). Shared components (c78), the shared motion kit ($lib/ui/motion), and blue only for main " +
  "actions (c95). Where things run: localhost:5180 is pm2 virev-demo. Take shots with `node apps/virev-demo/scripts/shot-browser.mjs`.";
// From its 'onboarding start flow' brief, 10-19 05:58Z, which named both.
const ONBOARDING_START_FLOW = "Take one desktop shot per page at 1440x900 (c25). Split: one job, with a design lead deciding first, then one builder per part " +
  "spawned flat.\nRules:\n- Read the frontend design and frontend-implementation skills first.\n- Use only the shared kit ($lib/ui, Menu, FormPanel, FilterMenu, " +
  "AddRow and InlineField), with Watchlist as the first pattern source (c78, c48, c54).\n- Don't restyle Watchlist, the Inbox desk, the wide profile viewer or " +
  "Connections.\n- Never kill 5180.";
// Its 'shot relay cache' brief, 10-19 17:02Z: a 5180 job that changes no screen.
const SHOT_RELAY_CACHE = "Owner rule c103 keeps browsers off the Mac, so every demo job shoots through apps/virev-demo/scripts/shot-browser.mjs, whose browser " +
  "runs on us-metal02 and relays page requests to the Mac's localhost:5180. My read: the relay makes every page slow. Task: cut relay page time to a few seconds warm.";

test("a UI job brief that does not name the frontend design skill gets the c48 line", () => {
  assert.equal(uiRuleLine(DASHBOARD_FIRST_RUN), UI_RULE_LINE);
  assert.match(jobLedgerPrompt(null, DASHBOARD_FIRST_RUN), /^- c48 .*frontend-implementation.*\$lib\/ui.*Dashboards app/m);
});

test("a UI brief that names the skill and the shared components, and a 5180 job that builds no screen, get no c48 line", () => {
  assert.equal(uiRuleLine(ONBOARDING_START_FLOW), null);
  assert.equal(uiRuleLine(SHOT_RELAY_CACHE), null);
  assert.doesNotMatch(jobLedgerPrompt(null, SHOT_RELAY_CACHE), /c48/);
});

const briefMessage: AgentMessage = { role: "user", content: [{ type: "text", text: `[task from parent]\n\n${DASHBOARD_FIRST_RUN}` }], timestamp: 0 };
const briefEntry = { type: "message", id: "e1", parentId: null, timestamp: "2026-10-19T15:19:40.000Z", message: briefMessage } as SessionEntry;

test("a job's first context carries the c48 line read from its brief, and a compacted job's block reads the brief again", () => {
  const appended: string[] = [];
  const first = deliverCorrections({ messages: [briefMessage], branch: [briefEntry], ledger: null, job: true, brief: new Set(), append: data => appended.push(data.text) });
  assert.match(appended[0]!, /^- c48 /m);
  assert.ok(first.some(message => message.role === "user" && JSON.stringify(message.content).includes("frontend-implementation")));
  const compaction = { type: "compaction", id: "e2", parentId: "e1", timestamp: "2026-10-19T16:00:00.000Z", summary: "s", firstKeptEntryId: "e2", tokensBefore: 1 } as unknown as SessionEntry;
  appended.length = 0;
  deliverCorrections({ messages: [], branch: [briefEntry, compaction], ledger: null, job: true, brief: new Set(), append: data => appended.push(data.text) });
  assert.match(appended[0]!, /^- c48 /m);
});
