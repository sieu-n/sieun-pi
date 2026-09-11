import { createHash } from 'node:crypto';
import { chatClientScript as script } from './chat-client.ts';

const css = `
:root { color-scheme: light; font: 15px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #30302c; background: #faf9f6; --canvas: #faf9f6; --sidebar: #f0efeb; --line: #dedcd5; --muted: #77756f; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; }
button, input, textarea { font: inherit; }
button { cursor: pointer; color: inherit; }
button:disabled { cursor: default; opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #555; outline-offset: 3px; }
button { border: 0; }
.app { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100vh; height: 100dvh; overflow: hidden; }
.app[data-sidebar-open="false"] { grid-template-columns: 0 minmax(0, 1fr); }
.app[data-sidebar-open="true"] #sidebar-toggle { display: none; }
.sidebar { display: flex; flex-direction: column; min-height: 0; padding: 16px 12px 12px; background: var(--sidebar); }
.brand-row { display: flex; justify-content: space-between; align-items: center; margin: 0 8px 20px; gap: 8px; }
.brand { font: 26px/1.2 Georgia, "Times New Roman", serif; letter-spacing: -.8px; }
.quiet-button { padding: 6px 10px; border-radius: 8px; background: transparent; font-size: .8125rem; white-space: nowrap; }
.quiet-button:hover:not(:disabled) { background: #eaeae7; }
.view-toggle { display: flex; gap: 4px; margin: 0 2px 10px; }
.view-toggle button { flex: 1; border-radius: 7px; padding: 6px; background: transparent; font-size: .8125rem; color: var(--muted); }
.view-toggle button[aria-pressed="true"] { background: #e5e3dc; color: #30302c; }
.search { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid transparent; background: #e8e6df; border-radius: 7px; font-size: .8125rem; }
.list-heading { margin: 20px 10px 6px; font-size: .6875rem; color: var(--muted); font-weight: 500; }
.session-list { flex: 1; min-height: 0; overflow: auto; padding: 0; margin: 0; list-style: none; }
.session-button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; padding: 8px 10px; border-radius: 7px; margin: 1px 0; }
.session-button:hover { background: #efefeb; }
.session-button[aria-current="true"] { background: #e4e1da; }
.session-name { flex: 1; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8125rem; }
.session-meta { width: 5px; height: 5px; flex: none; border-radius: 50%; background: transparent; }
.session-meta[data-status="running"] { background: #b57555; }
.list-notice { padding: 8px 10px; color: #71716c; font-size: .8125rem; }
.list-error { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: #fff; font-size: .8125rem; }
.list-error p { margin: 0 0 4px; overflow-wrap: anywhere; }
.sidebar-footer { padding: 10px 4px 0; margin-top: 8px; }
.sidebar-footer p { margin: 4px 4px 0; font-size: .75rem; color: #777770; }
.chat { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.chat-header { grid-row: 1; position: relative; display: flex; align-items: center; gap: 12px; padding: 12px 20px; min-height: 58px; }
.chat-title { min-width: 0; flex: 1; }
.chat-title h1 { margin: 0; font-size: .9375rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-status { font-size: .75rem; color: #777; margin: 2px 0 0; overflow-wrap: anywhere; }
.queue { font-size: .75rem; color: #666; white-space: nowrap; background: #f4f4f2; padding: 4px 9px; border-radius: 99px; }
.connection-banner { grid-row: 2; display: flex; align-items: center; gap: 12px; padding: 10px 24px; background: #fff7e9; font-size: .8125rem; }
.connection-banner p { margin: 0; flex: 1; overflow-wrap: anywhere; }
.conversation { grid-row: 3; min-height: 0; overflow: auto; overscroll-behavior: contain; scroll-behavior: auto; }
.transcript { max-width: 49rem; margin: 0 auto; padding: 32px 28px 30px; overflow-wrap: anywhere; }
.empty-state { padding: 16vh 0 48px; text-align: center; color: #777; }
.empty-state h2 { color: #333; font-size: 1.25rem; font-weight: 500; margin: 0 0 10px; }
.empty-state p { font-size: .875rem; margin: 0; }
.composer-region { grid-row: 4; padding: 10px 28px 22px; background: var(--canvas); }
.composer-wrap { max-width: 46rem; margin: auto; }
.latest-row { display: flex; justify-content: center; height: 0; position: relative; }
.latest-button { position: absolute; bottom: 12px; border: 1px solid #ddd; border-radius: 99px; padding: 6px 14px; background: #fff; box-shadow: 0 2px 8px #0000000a; font-size: .8125rem; }
.composer { position: relative; padding: 14px 14px 12px 18px; background: #fffefa; border: 1px solid #d9d6ce; border-radius: 20px; box-shadow: 0 2px 8px #302c2510; }
.composer:focus-within { border-color: #b6b6b6; }
.composer textarea { display: block; width: 100%; resize: vertical; min-height: 52px; max-height: 200px; border: 0; outline: none; background: transparent; padding: 2px 4px 10px 0; font-size: .9375rem; line-height: 1.55; color: #30302c; }
.composer textarea:focus-visible { outline: none; }
.composer textarea:disabled { color: #777; }
.composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.composer-target { min-width: 0; color: #777; font-size: .75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.send-button { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; border-radius: 9px; background: #c47755; color: #fff; line-height: 1; }
.composer-help { margin: 8px 0 0; text-align: center; color: #808080; font-size: .6875rem; }
.send-notice { font-size: .8125rem; margin: 8px 2px 0; color: #63635e; overflow-wrap: anywhere; }
.send-notice[data-kind="error"] { color: #9c3024; }
.pair { margin: 0 0 42px; }
.question { width: fit-content; max-width: 85%; margin-left: auto; padding: 12px 18px; border-radius: 16px; background: #eae8e1; overflow-wrap: anywhere; }
.question + .question { margin-top: 12px; }
.response { min-width: 0; margin-top: 26px; font: 17px/1.7 Georgia, "Times New Roman", serif; }
.response + .question { margin-top: 36px; }
.block { min-width: 0; margin: 16px 0; overflow-wrap: anywhere; }
.block > :first-child, .skill-body > :first-child { margin-top: 0; }
.block > :last-child, .skill-body > :last-child, .question > :last-child { margin-bottom: 0; }
.question > .block:first-of-type { margin-top: 0; }
.block p, .skill-body p { margin: 0 0 1em; }
.block :is(h1, h2, h3, h4, h5, h6), .skill-body :is(h1, h2, h3, h4, h5, h6) { font-weight: 600; line-height: 1.35; margin: 1.5em 0 .65em; }
.block h1, .skill-body h1 { font-size: 1.5rem; }
.block h2, .skill-body h2 { font-size: 1.25rem; }
.block :is(h3, h4, h5, h6), .skill-body :is(h3, h4, h5, h6) { font-size: 1.0625rem; }
.block :is(ul, ol), .skill-body :is(ul, ol) { margin: .75em 0 1em; padding-left: 1.5em; }
.block li, .skill-body li { margin: .35em 0; }
.block li > p, .skill-body li > p { margin: .5em 0; }
pre { max-width: 100%; overflow-x: auto; padding: 16px; background: #efede7; border: 1px solid #e7e4dc; border-radius: 10px; line-height: 1.5; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .875em; }
:not(pre) > code { background: #f0f0f0; padding: .15em .3em; border-radius: 4px; }
pre code { overflow-wrap: normal; }
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: .9375rem; margin: 1em 0; }
th, td { border-bottom: 1px solid #e5e5e5; padding: 10px 14px; text-align: left; }
blockquote { border-left: 3px solid #ddd; padding-left: 16px; color: #666; margin: 1em 0; }
hr { border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0; }
.transcript details { min-width: 0; margin-top: 16px; }
.transcript summary { width: fit-content; max-width: 100%; cursor: pointer; color: #666; font-size: .875rem; }
.transcript details[open] > summary { margin-bottom: 12px; }
.skill-body { margin-top: 12px; padding-left: 16px; border-left: 2px solid #ddd; overflow-wrap: anywhere; }
.inert-url, .attachment, .missing, .notice { color: #777; overflow-wrap: anywhere; }
.attachment, .missing, .notice { font-size: .875rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

.icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; border-radius: 7px; background: transparent; }
.icon-button:hover:not(:disabled) { background: #e8e5dd; }
.icon-button svg, .send-button svg { width: 18px; height: 18px; }
.header-actions, .composer-right { display: flex; align-items: center; gap: 7px; }
.model-trigger { display: flex; align-items: center; gap: 5px; max-width: min(250px, 45vw); border-radius: 6px; padding: 5px 7px; background: transparent; font-size: .75rem; }
.model-trigger:hover:not(:disabled) { background: #eeece5; }
#model-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-trigger svg { width: 13px; height: 13px; flex: none; }
.popover { position: absolute; z-index: 5; width: 320px; max-width: calc(100vw - 32px); padding: 10px; background: #fffefa; border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 28px #2420181c; font-family: system-ui, sans-serif; }
.popover-header { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px 4px; }
.popover-header h2 { margin: 0; font-size: .875rem; font-weight: 550; }
.model-panel { bottom: calc(100% + 8px); right: 0; }
.model-options { max-height: min(340px, 50vh); overflow: auto; margin-top: 6px; }
.model-option { display: block; width: 100%; border-radius: 7px; padding: 9px 10px; background: transparent; text-align: left; }
.model-option:hover:not(:disabled), .model-option[aria-selected="true"] { background: #eeece5; }
.model-option-name { display: block; font-size: .8125rem; }
.model-option-meta { display: block; font-size: .6875rem; color: var(--muted); }
.panel-note { margin: 8px 4px 2px; color: var(--muted); font: 11px/1.5 system-ui, sans-serif; }
.usage-panel { top: calc(100% - 2px); right: 16px; width: 290px; }
#usage-content { font-size: .8125rem; padding: 0 4px; }
#usage-content dl { display: grid; grid-template-columns: 1fr auto; gap: 9px 16px; margin: 12px 0; }
#usage-content dt { color: var(--muted); } #usage-content dd { margin: 0; font-variant-numeric: tabular-nums; }
#usage-content p { color: var(--muted); font-size: .75rem; }
.attachment-previews { display: flex; gap: 9px; overflow: auto; padding: 0; }
.attachment-previews:not(:empty) { padding: 0 2px 12px; }
.attachment-preview { position: relative; flex: none; width: 72px; height: 72px; }
.attachment-preview img { width: 72px; height: 72px; object-fit: cover; border: 1px solid var(--line); border-radius: 9px; }
.attachment-remove { position: absolute; top: -3px; right: -3px; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: #fff; background: #514d45; font-size: 12px; }
.attachment-error { color: #974735; font-size: .75rem; margin: 8px 2px 0; }
.composer[data-dragging="true"] { outline: 2px solid #c47755; outline-offset: 3px; }
.message-images { display: flex; flex-wrap: wrap; gap: 8px; }
.message-images + .block { margin-top: 12px; }
.chat-image-button { display: block; padding: 0; background: transparent; border-radius: 10px; overflow: hidden; }
.chat-image { display: block; max-width: min(340px, 100%); max-height: 280px; object-fit: contain; border-radius: 10px; }
.image-viewer { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 40px; background: #25231deb; }
.image-viewer img { max-width: 100%; max-height: 100%; object-fit: contain; }
.image-viewer .icon-button { position: absolute; top: 14px; right: 14px; color: #fff; }
.image-viewer .icon-button:hover { background: #ffffff22; }
.sidebar-menu { position: relative; margin: 0; }
.sidebar-menu summary { list-style: none; width: fit-content; padding: 5px 8px; cursor: pointer; color: var(--muted); font-size: 12px; border-radius: 6px; }
.sidebar-menu summary::-webkit-details-marker { display: none; }
.sidebar-menu[open] { padding-top: 5px; }

.sidebar-backdrop { display: none; }
@media (max-width: 760px) {
  .app, .app[data-sidebar-open="false"] { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: fixed; inset: 0 auto 0 0; width: min(300px, 85vw); z-index: 3; }
  .sidebar-backdrop:not([hidden]) { display: block; position: fixed; inset: 0; background: #0005; z-index: 2; }
  .chat-header { padding: 12px 14px; gap: 8px; min-height: 70px; }
  .transcript { padding: 24px 18px 20px; }
  .question { max-width: 92%; padding: 12px 16px; }
  .composer-region { padding: 6px 12px max(12px, env(safe-area-inset-bottom)); }
  .composer-help { font-size: .625rem; }
  .connection-banner { padding: 8px 14px; }
  .queue { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
}
`;


export const chatContentSecurityPolicy = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; script-src-attr 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; style-src-attr 'none'; connect-src 'self'; img-src data: blob:; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const icons = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  usage: '<path d="M4 16a9 9 0 1 1 16 0M12 12l4-4"/><circle cx="12" cy="12" r="1.5"/>',
};
function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

export function renderChatPage({ initialSessionId, csrfToken }: { initialSessionId: string; csrfToken: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(chatContentSecurityPolicy)}"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>Prime</title><style>${css}</style></head>
<body data-initial-session-id="${escapeAttribute(initialSessionId)}" data-chat-token="${escapeAttribute(csrfToken)}">
<div id="app" class="app" data-sidebar-open="true">
<button id="sidebar-backdrop" class="sidebar-backdrop" type="button" tabindex="-1" aria-label="Hide sidebar" hidden></button>
<aside id="sidebar" class="sidebar" aria-label="Sessions and agents">
  <div class="brand-row"><span class="brand">Prime</span><button id="hide-sidebar" class="icon-button" type="button" aria-label="Hide sidebar" title="Hide sidebar">${icon('sidebar')}</button></div>
  <div class="view-toggle" role="group" aria-label="Conversation type"><button id="view-sessions" type="button" aria-pressed="true">Chats</button><button id="view-agents" type="button" aria-pressed="false">Agents</button></div>
  <label class="sr-only" for="session-search">Search sessions and agents</label><input id="session-search" class="search" type="search" placeholder="Search" autocomplete="off">
  <h2 id="list-heading" class="list-heading">Recent chats</h2>
  <div id="list-error" class="list-error" role="status" hidden><p id="list-error-text"></p><button id="retry-list" type="button" class="quiet-button">Retry</button></div>
  <p id="list-notice" class="list-notice">Loading...</p><ul id="session-list" class="session-list" aria-labelledby="list-heading"></ul>
  <div class="sidebar-footer"><details class="sidebar-menu"><summary aria-label="Chat options">···</summary><button id="close-chat" class="quiet-button" type="button" title="Close this view without stopping agents">Close chat</button></details></div>
</aside>
<main class="chat">
  <header class="chat-header">
    <button id="sidebar-toggle" class="icon-button" type="button" aria-label="Show sidebar" title="Show sidebar" aria-controls="sidebar" aria-expanded="true">${icon('sidebar')}</button>
    <div class="chat-title"><h1 id="session-title">Prime</h1><p id="session-status" class="header-status" hidden></p></div>
    <div class="header-actions"><span id="queue-count" class="queue" aria-live="polite" hidden></span><button id="usage-button" class="icon-button" type="button" aria-label="Session usage" title="Session usage" aria-expanded="false" aria-controls="usage-panel">${icon('usage')}</button></div>
    <section id="usage-panel" class="popover usage-panel" role="dialog" aria-label="Session usage" hidden><div class="popover-header"><h2>Usage</h2><button id="usage-close" class="icon-button" type="button" aria-label="Close usage">${icon('close')}</button></div><div id="usage-content"></div></section>
  </header>
  <div id="connection-banner" class="connection-banner" role="status" hidden><p id="connection-text"></p><button id="retry-session" class="quiet-button" type="button">Retry</button></div>
  <div id="conversation" class="conversation" tabindex="0" role="region" aria-label="Conversation"><div id="transcript" class="transcript"><div class="empty-state"><p>Loading...</p></div></div></div>
  <footer class="composer-region"><div class="composer-wrap"><div class="latest-row"><button id="latest" class="latest-button" type="button" aria-label="Go to latest message" hidden>↓</button></div>
    <form id="composer-form" class="composer">
      <div id="attachment-previews" class="attachment-previews" aria-label="Attached images"></div>
      <label class="sr-only" for="message">Message the selected session</label>
      <textarea id="message" rows="2" maxlength="32000" placeholder="Reply..." aria-describedby="composer-help composer-target" autocomplete="off" disabled></textarea>
      <div class="composer-actions">
        <button id="attach-button" class="icon-button" type="button" aria-label="Attach images" title="Attach images" disabled>${icon('plus')}</button>
        <input id="image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <span id="composer-target" class="sr-only">Choose a session</span>
        <div class="composer-right"><button id="model-button" class="model-trigger" type="button" aria-label="Change model" aria-expanded="false" aria-controls="model-panel" disabled><span id="model-label">Model</span>${icon('down')}</button><button id="send" class="send-button" type="submit" aria-label="Send message" disabled>${icon('up')}</button></div>
      </div>
      <section id="model-panel" class="popover model-panel" role="dialog" aria-label="Choose a model" hidden>
        <div class="popover-header"><h2>Model</h2><button id="model-close" class="icon-button" type="button" aria-label="Close model menu">${icon('close')}</button></div>
        <label class="sr-only" for="model-search">Search models</label><input id="model-search" class="search" type="search" placeholder="Search models" autocomplete="off">
        <div id="model-options" class="model-options"></div><button id="model-more" type="button" class="quiet-button">More models</button><p id="model-notice" class="panel-note" role="status"></p><p class="panel-note">Also updates Prime Agent's default model.</p>
      </section>
    </form>
    <p id="attachment-error" class="attachment-error" role="status" hidden></p><p id="send-notice" class="send-notice" role="status" aria-live="polite" hidden></p><p id="composer-help" class="sr-only">Enter to send. Shift+Enter for a new line. Paste or drop PNG, JPEG, GIF, or WebP images. Up to 4 images, 3 MiB each, 8 MiB total. Drafts stay in this tab until reload.</p>
  </div></footer>
</main></div>
<div id="image-viewer" class="image-viewer" role="dialog" aria-modal="true" aria-label="Image preview" hidden><button id="image-close" class="icon-button" type="button" aria-label="Close image">${icon('close')}</button><img id="image-full" alt="Attached image"></div>
<noscript>JavaScript is required for chat. /what-did-i-say opens a script-free snapshot.</noscript><script>${script}</script></body></html>`;
}
