// Owner, 10-23, with a shot of a page card for prime-under-load.html that read "Page not found": "often links to wrong page." On 10-22 a chat
// sent wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/page/sessions/..., and the card asked the wiki for /page/https://... . Every form a
// chat writes a wiki link in now opens the one page, and tell_owner refuses once a wiki: link that opens no page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { brokenWikiLinks, TELL_OWNER_DONE, tellOwner, tellTurn, wikiLinks } from "../src/chat-guard.ts";
import { normalizeArtifactTarget, parseArtifactTarget } from "../src/shared/artifact-link.ts";
import { renderMarkdown } from "../src/client/markdown.ts";
import { wikiPages } from "../src/client/reader.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const PAGE = "sessions/2026/10/23/0132-harness-load-discussion/prime-under-load.html";
const SENT = [
  "wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/page/sessions/2026/10/23/0132-harness-load-discussion/prime-under-load.html",
  "wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/page/sessions/2026/10/22/1533-account-pooling-switching/account-switching.html",
];
const FORMS = [
  `wiki:${PAGE}`,
  `wiki:/${PAGE}`,
  `wiki:/page/${PAGE}`,
  `wiki:page/${PAGE}`,
  `wiki:/raw/${PAGE}`,
  `wiki:raw/${PAGE}`,
  `wiki:${PAGE}#why-it-stalls`,
  `wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/page/${PAGE}`,
  `wiki:http://localhost:5176/page/${PAGE}#why-it-stalls`,
  `wiki:http://100.83.139.73:5176/raw/${PAGE}`,
  `wiki:us-metal02-dev.tail0c093d.ts.net:5176/page/${PAGE}`,
  `wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/page/${PAGE.replaceAll("-", "%2D")}`,
];

test("every form a chat writes a wiki link in names the one page", () => {
  for (const form of FORMS) {
    assert.deepEqual(parseArtifactTarget(form), { kind: "wiki", path: PAGE }, form);
    assert.equal(normalizeArtifactTarget(form), `wiki:${PAGE}`, form);
  }
  assert.equal(normalizeArtifactTarget(`https://us-metal02-dev.tail0c093d.ts.net:5176/raw/${PAGE}`), `wiki:${PAGE}`);
  assert.equal(parseArtifactTarget("wiki:domains/devops/index.html")?.kind, "wiki");
});

test("a wiki link that names no page is no target", () => {
  for (const form of ["wiki:", "wiki:/page/", "wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/", "wiki:https://x:5176/api/agent/page?path=a.html",
    "wiki:../secrets.html", "wiki:page/../x.html"]) assert.equal(parseArtifactTarget(form), null, form);
});

test("the two links the owner got on 10-22 open their pages in the card, the chip and the new tab link", () => {
  const text = `Here is what I found, ${SENT[0]}, and the switching page ${SENT[1]}.`;
  assert.deepEqual(wikiPages(text), [PAGE, "sessions/2026/10/22/1533-account-pooling-switching/account-switching.html"]);
  const html = renderMarkdown(text, "", null, true);
  assert.match(html, new RegExp(`data-target="wiki:${PAGE}"`), html);
  assert.match(html, new RegExp(`href="/page/${PAGE}"`), html);
  assert.doesNotMatch(html, /page\/https/, html);
  assert.deepEqual(wikiPages(`[the page](wiki:/page/${PAGE}#why)`), [PAGE]);
  assert.deepEqual(wikiPages(`see http://localhost:5176/raw/${PAGE}#why`), [PAGE]);
});

const at = (clock: string): number => Date.parse(`2026-10-23T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const result = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: true, timestamp: at(clock) }) as ThreadMessage;
const pages = new Set([PAGE]);
const exists = (path: string): boolean => pages.has(path);

test("tell_owner reads every wiki: link in a text, without the sentence's last stop", () => {
  assert.deepEqual(wikiLinks(`Done, wiki:${PAGE}. Also [this](wiki:/page/a.md) and llm-wiki:x.`), [`wiki:${PAGE}`, "wiki:/page/a.md"]);
  assert.deepEqual(wikiLinks("A link written as wiki:, wiki:. or `wiki:` names no page and is prose."), []);
});

test("tell_owner refuses once a wiki: link that opens no page, with the form that works", () => {
  const turn = tellTurn([owner("where is the load page?", "03:20:00")]);
  const text = "The load page is wiki:sessions/2026/10/23/0132-harness-load-discussion/prime-under-loads.html.";
  const first = tellOwner({ text }, turn, Date.now(), exists);
  assert.equal(first.kind, "refused");
  assert.match(first.text, /prime-under-loads\.html \(no page /);
  assert.match(first.text, /wiki:<path under the wiki's content folder>/);
  assert.deepEqual(brokenWikiLinks("see wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/", exists), ["wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/ (no page path in it)"]);
  const again = tellTurn([owner("where is the load page?", "03:20:00"), tell("t1", text, "03:20:10"), result("t1", first.text, "03:20:11")]);
  assert.deepEqual(tellOwner({ text }, again, Date.now(), exists), { kind: "sent", text: TELL_OWNER_DONE }, "the very same text again goes out");
});

test("tell_owner sends a link to a page that is there in any form, and checks nothing on a box without the wiki", () => {
  const turn = tellTurn([owner("where is the load page?", "03:20:00")]);
  for (const form of [...FORMS, SENT[0]!]) assert.deepEqual(tellOwner({ text: `It is here, ${form}` }, turn, Date.now(), exists), { kind: "sent", text: TELL_OWNER_DONE }, form);
  assert.deepEqual(tellOwner({ text: "It is here, wiki:nope/missing.html" }, turn, Date.now(), null), { kind: "sent", text: TELL_OWNER_DONE });
});
