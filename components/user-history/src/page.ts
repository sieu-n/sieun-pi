import { createHash } from "node:crypto";
import { Marked } from "marked";
import { parseSkillBlock } from "prime-agent";
import type { HistorySnapshot, QuestionPart } from "./history.ts";
import { chatImageDataUrl, type ChatImage } from "./chat-images.ts";

const css = `
:root { color-scheme: light; font: 16px/1.7 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #252525; background: #fff; }
* { box-sizing: border-box; }
body { margin: 0; padding: 28px 24px 64px; }
main { max-width: 48rem; margin: auto; }
.page-header { margin-bottom: 40px; }
.title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
.title-row h1 { font-size: 1.125rem; font-weight: 600; line-height: 1.4; margin: 0; }
.snapshot-label { margin: 0; color: #666; font-size: .8125rem; }
.page-header details { margin-top: 8px; }
.notice { color: #666; font-size: .875rem; }
.pair { margin: 0 0 48px; }
.question { width: fit-content; max-width: 80%; margin-left: auto; padding: 12px 20px; border-radius: 24px; background: #f4f4f4; overflow-wrap: anywhere; }
.question + .question { margin-top: 12px; }
.response { min-width: 0; margin-top: 28px; }
.block { min-width: 0; margin: 16px 0; overflow-wrap: anywhere; }
.block > :first-child, .skill-body > :first-child { margin-top: 0; }
.block > :last-child, .skill-body > :last-child { margin-bottom: 0; }
.question > .block:first-of-type { margin-top: 0; }
.question > :last-child { margin-bottom: 0; }
.block p, .skill-body p { margin: 0 0 1em; }
.block :is(h1, h2, h3, h4, h5, h6), .skill-body :is(h1, h2, h3, h4, h5, h6) { color: #252525; font-weight: 600; line-height: 1.35; margin: 1.5em 0 .65em; }
.block h1, .skill-body h1 { font-size: 1.5rem; }
.block h2, .skill-body h2 { font-size: 1.25rem; }
.block :is(h3, h4, h5, h6), .skill-body :is(h3, h4, h5, h6) { font-size: 1.0625rem; }
.block :is(ul, ol), .skill-body :is(ul, ol) { margin: .75em 0 1em; padding-left: 1.5em; }
.block li, .skill-body li { margin: .35em 0; }
.block li > p, .skill-body li > p { margin: .5em 0; }
.block li > :is(ul, ol), .skill-body li > :is(ul, ol) { margin: .35em 0; }
pre { max-width: 100%; overflow-x: auto; padding: 16px; background: #f6f6f6; border-radius: 12px; line-height: 1.5; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .875em; }
:not(pre) > code { background: #f0f0f0; padding: .15em .3em; border-radius: 4px; }
pre code { overflow-wrap: normal; }
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: .9375rem; margin: 1em 0; }
th, td { border-bottom: 1px solid #e5e5e5; padding: 10px 14px; text-align: left; }
th { font-weight: 600; }
blockquote { border-left: 3px solid #ddd; padding-left: 16px; color: #666; margin: 1em 0; }
hr { border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0; }
details { min-width: 0; margin: 16px 0 0; }
summary { width: fit-content; max-width: 100%; cursor: pointer; color: #666; font-size: .875rem; overflow-wrap: anywhere; }
summary:hover { color: #252525; }
summary:focus-visible { outline: 2px solid #666; outline-offset: 4px; border-radius: 2px; }
details[open] > summary { margin-bottom: 12px; }
.skill-body { margin-top: 12px; padding-left: 16px; border-left: 2px solid #ddd; overflow-wrap: anywhere; }
.inert-url { color: #666; overflow-wrap: anywhere; }
.attachment, .missing { color: #666; font-size: .875rem; overflow-wrap: anywhere; }
.snapshot-end { margin-top: 56px; font-size: .8125rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@media (max-width: 600px) {
  body { padding: 20px 16px 40px; }
  .page-header { margin-bottom: 32px; }
  .question { max-width: 92%; padding: 12px 16px; border-radius: 20px; }
  .pair { margin-bottom: 36px; }
  .response { margin-top: 24px; }
}
`;
export const contentSecurityPolicy = `default-src 'none'; script-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const markdown = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }) { return escapeText(text); },
    link({ href, title, tokens }) {
      return `<span>${this.parser.parseInline(tokens)} <span class="inert-url">(${escapeText(href)})${title ? ` ${escapeText(title)}` : ''}</span></span>`;
    },
    image({ href, title, text }) {
      return `<span class="attachment">Image blocked. ${escapeText(text)} <span class="inert-url">(${escapeText(href)})${title ? ` ${escapeText(title)}` : ''}</span></span>`;
    },
    code({ text }) { return `<pre><code>${escapeText(text)}</code></pre>\n`; },
    checkbox({ checked }) { return `<span>${checked ? '[x]' : '[ ]'}</span> `; },
  },
});

function renderParts(parts: readonly QuestionPart[]): string {
  if (!parts.length) return '<p class="missing">No text or attachments in this entry.</p>';
  return parts.map(part => {
    switch (part.kind) {
      case 'text':
        return part.text.trim()
          ? `<div class="block">${markdown.parse(part.text, { async: false })}</div>`
          : '<p class="missing">Empty saved text.</p>';
      case 'skill':
        return `<div class="block"><p>Skill /skill:${escapeText(part.name)}</p><div class="block">${markdown.parse(part.arguments, { async: false })}</div><details><summary>Injected skill instructions</summary><div class="skill-body">${markdown.parse(part.instructions, { async: false })}</div></details></div>`;
      case 'attachment':
        return `<p class="block attachment">${escapeText(part.label)}</p>`;
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  }).join('\n');
}

function renderReply(texts: readonly string[]): string {
  return texts.map(text => `<div class="block">${markdown.parse(text, { async: false })}</div>`).join('\n');
}


export function renderChatMessages(messages: readonly { id: string; role: "user" | "assistant"; text: string; streaming: boolean; images?: readonly ChatImage[] }[]): string {
  return messages.map(message => {
    const skill = message.role === "user" ? parseSkillBlock(message.text) : null;
    const body = skill
      ? renderParts([{ kind: "skill", name: skill.name, instructions: skill.content, arguments: skill.userMessage ?? "" }])
      : renderReply([message.text]);
    const images = (message.images ?? []).map((image, index) => `<button class="chat-image-button" type="button" aria-label="Open attached image ${index + 1}"><img class="chat-image" src="${escapeText(chatImageDataUrl(image))}" alt="Attached image ${index + 1}" loading="lazy"></button>`).join("");
    return `<section class="${message.role === "user" ? "question" : "response"}" data-message-id="${escapeText(message.id)}" aria-label="${message.role === "user" ? "You" : "Assistant"}">${images ? `<div class="message-images">${images}</div>` : ''}${body}${message.streaming ? '<p class="notice">Responding...</p>' : ''}</section>`;
  }).join("\n") || '<p class="missing">No messages in this conversation yet.</p>';
}

export function renderPage(snapshot: HistorySnapshot): string {
  const groups = snapshot.groups.map((group, index) => {
    const questions = group.questions.map((question, i) => `<section class="question" aria-labelledby="question-${index}-${i}"><h3 class="sr-only" id="question-${index}-${i}">Saved question${group.questions.length > 1 ? ` ${i + 1}` : ''}</h3>${renderParts(question.parts)}</section>`).join('\n');
    const latest = group.finals.at(-1);
    const earlier = group.finals.slice(0, -1);
    const response = latest
      ? `<h3 class="sr-only">Final response</h3>${renderReply(latest.texts)}`
      : '<p class="missing">No marked final response saved.</p>';
    const previous = earlier.length
      ? `<details><summary>Earlier final responses (${earlier.length})</summary>${earlier.map(reply => `<section class="response">${renderReply(reply.texts)}</section>`).join('\n')}</details>`
      : '';
    const unmarked = !latest && group.lastUnmarkedReply
      ? `<details><summary>Last reply without a final marker</summary><p class="notice">Final status is unavailable. This text may include progress.</p>${renderReply(group.lastUnmarkedReply.texts)}</details>`
      : '';
    return `<article class="pair" aria-labelledby="group-${index}"><h2 class="sr-only" id="group-${index}">Question group ${index + 1}</h2>${questions}<section class="response">${response}${previous}${unmarked}</section></article>`;
  }).join('\n');
  const orphanNotice = snapshot.orphanFinalCount
    ? `<p class="notice">${snapshot.orphanFinalCount} final responses without an earlier saved question omitted.</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeText(contentSecurityPolicy)}"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>What did I say?</title><style>${css}</style></head><body><main><header class="page-header"><div class="title-row"><h1>What did I say?</h1><p class="snapshot-label">Read-only snapshot</p></div><details><summary>About this snapshot</summary><p class="notice">Current conversation branch · oldest saved first · includes pre-compaction history.</p><p class="notice">Each group shows its latest marked final response. Earlier finals expand below it.</p><p class="notice">Grouped by saved order; exact question-to-response links were not recorded. A final marker does not prove task success. Consecutive saved questions can share a response group.</p><p class="notice">These are saved user-role messages, not a keystroke record. Native history does not prove human authorship for every user-role entry. Unsaved commands and other branches are not included.</p><p class="notice">Links and images are inert. Skill instructions expand without scripts. The local listener closes after this page is served or after 30 seconds. An open tab or browser copy can remain afterward.</p></details></header>${orphanNotice}${groups || '<p class="missing">No saved questions in this branch.</p>'}<footer class="notice snapshot-end">End of snapshot. Later messages may not be included.</footer></main></body></html>`;
}
