import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The page's chat view as plain HTML, painted before app.js arrives. On 10-18 a cold load from Korea (185 ms, about 100 KB/s) painted
 * nothing for 2.65 s, because app.js and app.css are 214 KB packed and the page drew only once app.js ran. The lines come from ChatLines.svelte,
 * rendered on the server from the same first page the shell carries (`prepaintLines`, built by chat-assets.ts `compileServer`); around them
 * goes a still copy of the chat view's frame, named by the components' scope classes (`scopeClass`). client/main.ts takes it away on the
 * first frame where the app shows the thread.
 */

const CLIENT_DIR = fileURLToPath(new URL("./client/", import.meta.url));

/**
 * A component's CSS scope class, from its path under src/client. The client and server compiles both use it (chat-assets.ts `cssHash`), so
 * the frame below can name App.svelte's or Chat.svelte's classes and get their styles from app.css. esbuild-svelte names a file relative to
 * the process's working folder.
 */
export function scopeClass(filename: string): string {
  const file = relative(CLIENT_DIR, resolve(process.cwd(), filename)).split("\\").join("/");
  return "svelte-" + createHash("sha256").update(file).digest("hex").slice(0, 10);
}

/** What the server half of the client bundle exports (client/prepaint-lines.ts). */
export interface PrepaintModule { prepaintLines(id: string, frames: string): { lines: string; title: string } | null }

/**
 * Runs before the first paint, after the stylesheet (an inline script waits for the stylesheets above it). It applies what the app reads from
 * localStorage that moves the frame: the theme and accent (client/appearance.ts), the sidebar width, and the board panel's state and width
 * (client/ui.svelte.ts). It writes each time stamp in the browser's own time zone, as ChatLines.svelte `stamp` does, and scrolls the lines to
 * the bottom. test/prepaint.test.ts holds it to those files.
 */
export const prepaintScript = `(function(){var r=document.documentElement,p=document.getElementById("prepaint");if(!p)return;try{
var s=localStorage,a=null;try{a=JSON.parse(s.getItem("chat.appearance")||"null")}catch(e){}a=a||{};
if(a.theme==="light"||a.theme==="dark")r.dataset.theme=a.theme;
if(["violet","green","amber","rose","graphite"].indexOf(a.accent)>=0)r.dataset.accent=a.accent;
r.style.setProperty("--prepaint-sidebar",Math.round(Math.min(480,Math.max(180,Number(s.getItem("chat.sidebarWidth"))||260)))+"px");
if(s.getItem("chat.boardOpen")!=="0")r.dataset.prepaintBoard="";
r.style.setProperty("--prepaint-board",Math.round(Math.min(Math.max(280,Math.floor(innerWidth*0.6)),Math.max(280,Number(s.getItem("chat.boardWidth"))||320)))+"px");
}catch(e){}
var today=new Date().toDateString();p.querySelectorAll("[data-stamp]").forEach(function(n){var d=new Date(Number(n.getAttribute("data-stamp")));
n.textContent=d.toDateString()===today?d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}):d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})});
var c=p.querySelector("[data-prepaint-scroller]");if(c)c.scrollTop=c.scrollHeight;
})();`;

/** The CSP source that lets exactly this inline script run. */
export const prepaintHash = `'sha256-${createHash("sha256").update(prepaintScript).digest("base64")}'`;

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The still chat view around the server-rendered lines: App.svelte's frame, an empty sidebar (the rows come with the sessions list after
 * app.js), and Chat.svelte's header, feed, composer and board panel. It is a copy of their markup, so a change there that moves the feed
 * shows as a jump when the app takes over; the classes it names are checked against app.css in test/prepaint.test.ts.
 */
export function prepaintHtml(page: { lines: string; title: string }): string {
  const [app, sidebar, chat, title, composer] = ["App.svelte", "Sidebar.svelte", "Chat.svelte", "ThreadTitle.svelte", "ChatComposer.svelte"].map(file => scopeClass(resolve(CLIENT_DIR, file)));
  return `<div id="prepaint" inert><div class="app ${app}"><div class="body ${app}">` +
    `<aside class="sidebar ${sidebar} open"><div class="inner ${sidebar}"></div></aside>` +
    `<main class="main ${app}"><div class="chat ${chat}">` +
    `<header class="head ${chat}"><div class="title-wrap ${title}"><span class="title ${title}">${escapeText(page.title)}</span></div></header>` +
    `<div class="body ${chat}"><div class="main ${chat}">` +
    `<div class="scroller ${chat}" data-prepaint-scroller><div class="column ${chat}">${page.lines}</div></div>` +
    `<div class="foot ${chat}"><div class="column ${chat}"><div class="chat-composer ${composer}"><div class="row ${composer}">` +
    `<textarea class="${composer}" placeholder="Message" rows="1" tabindex="-1" disabled></textarea><span class="send ${composer}"></span></div></div></div></div>` +
    `</div><aside class="side ${chat}"></aside></div></div></main></div></div></div>\n<script>${prepaintScript}</script>\n`;
}
