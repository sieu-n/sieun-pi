/*
 * A For you ask to contact a vendor's support (owner rule c79). The owner, 10-15: "STOP FUCKING COMPLAINING, NEVER EVER LEAVE SUPPORT THAT IS
 * NOT THE WAY TO SOLVE IT". The briefs then held the rule, yet on 10-18 a job put t49 on VP of CI's For you, "we send GitHub Support one request
 * (draft on the page). Can I send it right after the wipe?", read as a c37 outside send that only needs his ok, and he answered "NONONONO..."
 * on 10-19. Five hours after a prompt note for c79 landed, Crawler VP's t52 asked "Can a job ask GeoNode support to move us to a working host?"
 * (c127). The board refuses such a todo; the hard refusal guards an outside send (c37) the owner ruled out for good (c79).
 */

const CONTACT = String.raw`(?:ask(?:s|ed|ing)?|contact(?:s|ed|ing)?|e-?mail(?:s|ed|ing)?|messag(?:e|es|ed|ing)|writ(?:e|es|ing)\s+to|reach(?:es|ing)?\s+out\s+to|` +
  String.raw`ping(?:s|ed|ing)?|send(?:s|ing)?|sent|open(?:s|ed|ing)?|fil(?:e|es|ed|ing)|submit(?:s|ted|ting)?|rais(?:e|es|ed|ing)|escalat(?:e|es|ed|ing)\s+to|` +
  String.raw`go(?:es)?\s+(?:through|to)|request(?:s|ed|ing)?\s+from|follow(?:s|ed|ing)?[\s-]up\s+with)`;
const ASKS: readonly RegExp[] = [
  // "send GitHub Support one request", "ask GeoNode support", "sends it in GeoNode's support chat", "email the help desk"
  new RegExp(String.raw`\b${CONTACT}\s+(?:[^\s.?!;]+\s+){0,3}?(?:support|help\s*desk|helpdesk)\b(?!\s+(?:for|of|reply|replies|answer)\b)`, "iu"),
  // "the support note drafted in the scratchpad", "a support ticket", "a short support ask"
  /\bsupport\s+(?:requests?|tickets?|chats?|notes?|asks?|cases?|e-?mails?|messages?|forms?|team|agents?|staff)\b/iu,
  // "open a ticket with iWebFusion", "a follow-up on the open ticket", "in the same ticket", "support@vendor.example"
  /\b(?:open|file|submit|raise)\s+(?:a|an|another|the|one)\s+(?:[\w-]+\s+)?tickets?\b|\b(?:on|in)\s+the\s+(?:same|open|existing)\s+ticket\b|\bsupport@/iu,
];
/** "never ask GitHub Support", "without contacting their support": a sentence that rules the contact out names it without asking for it. */
const NEGATED = /\b(?:never|not|no|don['\u2019]?t|won['\u2019]?t|without|instead\s+of|rather\s+than|skip(?:s|ping)?)\b[^.?!;]{0,40}$/iu;
/** Our own customers' support ("Send Barn a short support reply", slack-green 10-07) is an outside send c37 covers, not a vendor. */
const OURS = /\b(?:customers?|our\s+(?:users?|support))\b/iu;

/** The sentence of a text that asks to contact a vendor's support, or null. */
export function vendorSupportAsk(text: string): string | null {
  for (const sentence of text.split(/(?<=[.?!;])\s+|\n+/)) {
    if (OURS.test(sentence)) continue;
    for (const pattern of ASKS) {
      const hit = pattern.exec(sentence);
      if (hit && !NEGATED.test(sentence.slice(0, hit.index))) return sentence.trim();
    }
  }
  return null;
}

export const VENDOR_SUPPORT_ERROR = "Refused: the owner never asks a vendor's support for help and never wants to be asked to approve it (c79, owner 10-15 " +
  "\"NEVER EVER LEAVE SUPPORT\", 10-19 \"NONONO\" on a GitHub Support todo). Solve it yourself through the vendor's portal, its API, the box's " +
  "remote console and SSH. If no self-serve path exists, write that limit in the step's note as a known gap and drop the support step; " +
  "put no ticket, chat, request or complaint to a vendor on For you.";
