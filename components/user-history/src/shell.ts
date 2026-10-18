import { bootFeedHash, bootFeedScript } from "./boot-feed.ts";
import { prepaintHash } from "./prepaint.ts";

/** The page shell and its headers, with no import beyond the boot and still-view scripts, so a service that is still starting can send it (src/early-shell.ts). */
export const contentSecurityPolicy = "default-src 'none'; script-src 'self' " + bootFeedHash + " " + prepaintHash + "; style-src 'self'; img-src 'self' data: blob: https:; frame-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function escapeAttribute(text: string): string { return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"); }

/**
 * The page shell, in two parts. `shellHead` goes out at once: the script and style by their hashed names (`assetName`), so a later load
 * reads them from the browser's cache, and the inline boot script, which opens the feeds socket while app.js is still on its way
 * (boot-feed.ts). The stylesheet comes after that script, because an inline script waits for every stylesheet above it to load; a preload above
 * app.js asks for it first, since the chat's still view (prepaint.ts) paints once it arrives. `data-chats`
 * names the chats, so a thread URL paints its chat view from the snapshot instead of waiting for the sessions list to say it is a chat
 * (10-18: 1.4 MB, 4 to 5 s after the snapshot from Korea).
 */
export function shellHead(csrfToken: string, version: string, wiki: string | null, assets: { js: string; css: string } = { js: "app.js", css: "app.css" }, chats: Iterable<string> = []): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Prime Agent chat</title>
<link rel="preload" href="${escapeAttribute(assets.css)}" as="style">
<script type="module" src="${escapeAttribute(assets.js)}"></script>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="icon" type="image/png" sizes="64x64" href="favicon-64.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f8f9fb">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#17181c">
</head>
<body data-chat-token="${escapeAttribute(csrfToken)}" data-build="${escapeAttribute(version)}" data-wiki="${escapeAttribute(wiki ?? "")}" data-chats="${escapeAttribute([...chats].join(","))}">
<script>${bootFeedScript}</script>
<link rel="stylesheet" href="${escapeAttribute(assets.css)}">
`;
}

/**
 * The rest of the shell, with the first frames of the thread the URL names (`?t=`) in the shape its feed sends them, so the page paints the
 * thread with no request of its own. app.js is a module script, so it runs only once this part has arrived. `prepaint` is the chat's still
 * view (prepaint.ts), which paints before app.js arrives.
 */
export function shellTail(thread: { id: string; json: string } | null = null, prepaint = ""): string {
  const inline = thread ? `<script type="application/json" id="boot-thread" data-id="${escapeAttribute(thread.id)}">${thread.json}</script>\n` : "";
  return `${inline}${prepaint}<div id="app"></div>
</body>
</html>
`;
}
