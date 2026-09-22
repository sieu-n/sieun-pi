import { Marked } from "marked";
import { parseSkillBlock } from "prime-agent";
import type { ChatMessage } from "./chat-backend.ts";
import { chatImageDataUrl, type ChatImage } from "./chat-images.ts";

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

function renderReply(texts: readonly string[]): string {
  return texts.map(text => `<div class="block">${markdown.parse(text, { async: false })}</div>`).join('\n');
}


export function renderChatMessages(messages: readonly (Omit<ChatMessage, "images"> & { images?: readonly ChatImage[] })[]): string {
  return messages.map(message => {
    const skill = message.role === "user" ? parseSkillBlock(message.text) : null;
    const body = skill
      ? `<div class="block"><p>Skill /skill:${escapeText(skill.name)}</p>${renderReply([skill.userMessage ?? ""])}<details><summary>Injected skill instructions</summary><div class="skill-body">${markdown.parse(skill.content, { async: false })}</div></details></div>`
      : renderReply([message.text]);
    const images = (message.images ?? []).map((image, index) => `<button class="chat-image-button" type="button" aria-label="Open attached image ${index + 1}"><img class="chat-image" src="${escapeText(chatImageDataUrl(image))}" alt="Attached image ${index + 1}" loading="lazy"></button>`).join("");
    const tools = (message.tools ?? []).map(tool => `<details class="tool" data-disclosure-id="tool:${escapeText(tool.id)}" data-tool-id="${escapeText(tool.id)}" data-tool-revision="${escapeText(tool.revision)}"><summary><span>${escapeText(tool.name)}</span> · ${escapeText(tool.status)}${tool.durationMs === undefined ? '' : ` · ${(tool.durationMs / 1000).toFixed(1)}s`} · ${escapeText(tool.summary)}</summary><div class="tool-content"><p class="notice">Open to load native arguments and output.</p></div></details>`).join('');
    return `<section class="${message.role === "user" ? "question" : "response"}" data-message-id="${escapeText(message.id)}" data-outcome="${message.outcome ?? ''}" aria-label="${message.role === "user" ? "You" : "Assistant"}">${images ? `<div class="message-images">${images}</div>` : ''}${message.outcome ? `<p class="notice">${message.outcome === 'aborted' ? 'Aborted' : 'Error'}</p>` : ''}${body}${tools}${message.streaming ? '<p class="notice">Responding...</p>' : ''}</section>`;
  }).join("\n") || '<p class="missing">No messages in this conversation yet.</p>';
}
