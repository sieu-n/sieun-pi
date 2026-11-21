/**
 * crammedLine against the owner's model reply: on 11-21 agent factory's DM comm thread drafted a paragraph of four sentences, three of them
 * things it was doing, and comm-guard held it once as crammed. The next draft put those three in bullets under a lead-in line, and once it
 * went out the owner wrote "정말 훌륭한 메시지였어" (DM msg mwqtp2l1). So the draft is held and the post he praised passes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { crammedLine } from "../../src/durable/comm-guard.ts";

const praised = "yes, all three are running.\n\nThe way I read your intent, sw factory should feel like Slack with coworkers. You drop a message, an agent answers like Prime chat would, works in the background and comes back with the result.\n\nHere's what's moving toward that:\n- why replies here feel stiffer than Prime's, compared with the real prompts\n- replies that read like a normal message, with line breaks and a pick before any question\n- unslop loading the way it does in Prime\n\nI'll come back with a before and after once it's live.";
const draft = "yes, all three are running.\n\nThe way I read your intent, sw factory should feel like Slack with coworkers. You drop a message, an agent answers the way Prime chat does, does the work in the background and comes back with the result.\n\nSo here it is again in that shape. I'm checking why replies here feel stiffer than Prime's, with real prompts side by side. I'm also making them read like a normal message, with line breaks and a pick before any question. And unslop will load the way it does in Prime.\n\nI'll come back with a before and after once it's live.";

test("the reply the owner praised passes", () => {
  assert.equal(crammedLine(praised), undefined);
});

test("its draft, three things in a row in one paragraph, is held", () => {
  assert.match(crammedLine(draft) ?? "", /^So here it is again in that shape\./);
});
