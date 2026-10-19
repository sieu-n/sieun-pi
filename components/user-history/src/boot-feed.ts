import { createHash } from "node:crypto";

/**
 * The page's first script, inline in the shell so it runs before app.js arrives. It opens the feeds socket and names the sessions list and
 * the thread the URL opens in the socket URL itself, so the server starts both feeds on the upgrade with no subscribe round trip. The
 * frames wait in `window.__bootFeed` until `client/feeds.ts` adopts the socket. On 10-18 a cold load from Korea sent its subscribes only
 * after app.js (227 KB) ran: about four round trips of 185 ms before the first message could arrive.
 *
 * The URL parse is `pageTarget` in client/permalink.ts in a few lines; `test/cold-load.test.ts` holds the two to the same answer.
 */
export const BOOT_SUBS = { thread: 1, sessions: 2 } as const;

export const bootFeedScript = `(function(){try{
var raw=decodeURIComponent(location.hash.slice(1)),at=raw.lastIndexOf("@"),id=at>0&&/^\\d+$/.test(raw.slice(at+1))?raw.slice(0,at):raw;
if(!id)id=new URLSearchParams(location.search).get("t");
var subs=[];if(id)subs.push({sub:${BOOT_SUBS.thread},feed:"thread",id:id,delta:true});subs.push({sub:${BOOT_SUBS.sessions},feed:"sessions",delta:true});
var url=new URL("api/ws",document.baseURI);url.protocol=url.protocol==="https:"?"wss:":"ws:";
url.searchParams.set("token",document.body.dataset.chatToken||"");url.searchParams.set("subs",JSON.stringify(subs));
var socket=new WebSocket(url),boot={socket:socket,subs:subs,frames:[]};
socket.onmessage=function(m){boot.frames.push(m.data)};window.__bootFeed=boot;
}catch(e){}})();`;

/**
 * The head's first script, ahead of the stylesheet preload and app.js: a URL that names a thread only in its hash, such as a board link or
 * an old bookmark, loads again with `?t=<id>`, which the server sees, so the shell carries that thread's first page and its still view
 * (prepaint.ts). The hash parse is the one above. On 10-19 from the Mac (195 ms a round trip) a `#<id>` cold load showed the chat after
 * app.js ran, at 1.52 to 1.66 s, and a `?t=<id>#<id>` one showed the still view at 0.88 to 1.38 s.
 */
export const bootTargetScript = `(function(){try{
var raw=decodeURIComponent(location.hash.slice(1)),at=raw.lastIndexOf("@"),id=at>0&&/^\\d+$/.test(raw.slice(at+1))?raw.slice(0,at):raw;
var query=new URLSearchParams(location.search);if(!/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)||query.get("t")===id)return;
query.set("t",id);location.replace(location.pathname+"?"+query+location.hash);
}catch(e){}})();`;

/** The CSP sources that let exactly these inline scripts run. */
export const bootTargetHash = `'sha256-${createHash("sha256").update(bootTargetScript).digest("base64")}'`;
export const bootFeedHash = `'sha256-${createHash("sha256").update(bootFeedScript).digest("base64")}'`;
