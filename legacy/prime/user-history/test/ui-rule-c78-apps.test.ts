// Guards owner rule c78 ("PLEASE FOR THE LOVE OF GOD USE CONSISTENT COMPONENTS", 10-15; "in general i hate to see agent inventing the design
// system from scratch whenever making new view", 10-22) in job briefs outside the 5180 demo. Until 10-28 a job's [corrections] block carried
// the rule only for a brief naming 5180, 5174, virev-demo or $lib/ui: a brief for apps/search by its path, or for sieun-pi's chat web client,
// got nothing, and the chat web client's jobs built seven pages with only lib/ui/README.md and the chat's own "(c78)" to hold it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_WEB_RULE_LINE, chatWebRuleLine, jobLedgerPrompt, UI_RULE_LINE, uiRuleLine } from "../src/chat-corrections.ts";
import { NAMES_PARTS, PARTS_LINE } from "../scripts/clean-room/chat-web-parts.ts";

// The AI harness chat's 'new app settings menu' brief, 10-28 03:17Z, cut to its UI lines.
const SETTINGS_MENU = "He sent it while using the new chat app at https://us-metal02-dev.tail0c093d.ts.net:5184. Its top bar today reads: + | Messages | " +
  "Agents | Board | Usage | Hosts | Search (Cmd-K), with his avatar at the right. My read: the top bar should keep only the daily surfaces. Usage, " +
  "Hosts and any other admin or ops page move into one Settings page. Do this: 1. In sieun-pi apps/chat (web/src), make that change with the app's " +
  "existing components and styles. Invent no new design pieces (c78).";
// The same brief naming the shared parts.
const SETTINGS_NAMED = SETTINGS_MENU + " Build Settings from apps/chat/web/src/lib/ui (Page, NavItem, Panel), as its README lists them.";
// An ordinary owner-style ask turned into a brief for the Agents page.
const AGENTS_FILTER = "the agents page in the new chat app needs a filter row on top: tabs for running, idle and done, and a search box. " +
  "Work in sieun-pi apps/chat/web/src/pages/agents.";
// A chat web client brief that touches no screen.
const SEARCH_INDEX = "In sieun-pi apps/chat (web/src/lib/api and server/search-index.ts) the search index rebuild takes 40 s on a cold start; cut it under 5 s.";
// A real-app brief that names apps/search by path and no port.
const SEARCH_APP = "Port the Inbox sidebar into apps/search/src/routes/app/inbox so the real app's layout matches; keep its routes.";

test("a chat web client UI brief that does not name its lib/ui gets the c78 line, and not the auto-sns-agent c48 line", () => {
  assert.equal(chatWebRuleLine(SETTINGS_MENU), CHAT_WEB_RULE_LINE);
  assert.equal(chatWebRuleLine(AGENTS_FILTER), CHAT_WEB_RULE_LINE);
  assert.equal(uiRuleLine(SETTINGS_MENU), null);
  const block = jobLedgerPrompt(null, AGENTS_FILTER);
  assert.match(block, /^- c78 .*apps\/chat\/web\/src\/lib\/ui.*web-shared-ui\.test\.ts/m);
  assert.doesNotMatch(block, /^- c48 /m);
});

test("a chat web client brief that names lib/ui, or touches no screen, gets no c78 line", () => {
  assert.equal(chatWebRuleLine(SETTINGS_NAMED), null);
  assert.equal(chatWebRuleLine(SEARCH_INDEX), null);
  assert.equal(chatWebRuleLine(SEARCH_APP), null);
});

test("a UI brief for apps/search by its path gets the c48 line with the shared components", () => {
  assert.equal(uiRuleLine(SEARCH_APP), UI_RULE_LINE);
});

test("the chat-web-parts clean-room judge reads the real c78 line and a brief that names lib/ui", () => {
  assert.match(jobLedgerPrompt(null, AGENTS_FILTER), PARTS_LINE);
  assert.match(SETTINGS_NAMED, NAMES_PARTS);
  assert.doesNotMatch(SETTINGS_MENU, NAMES_PARTS);
});
