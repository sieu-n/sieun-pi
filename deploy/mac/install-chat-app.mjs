#!/usr/bin/env node
// Installs the sieun-pi chat as a Chrome app on this Mac: its own window and Dock icon, opening the chat host's URL.
//   node install-chat-app.mjs [--url <chat URL>] [--screenshot <png>]
// The URL defaults to roles.chat.url of ~/.config/sieun-pi/hosts.json plus the capability in ~/.config/sieun-pi/chat-access.json.
// Chrome refuses DevTools on its default profile folder, so the app gets its own: ~/Library/Application Support/sieun-pi/chat-app-chrome.
// Chrome opens one window while it installs and closes it at the end. A Chrome started from ssh with launchctl asuser can take 20 s or more to load. Running it again reinstalls the same app.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = join(homedir(), "Library/Application Support/sieun-pi/chat-app-chrome");

function option(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function chatUrl() {
  const explicit = option("--url");
  if (explicit) return new URL(explicit).href;
  const config = join(homedir(), ".config/sieun-pi");
  const hosts = JSON.parse(readFileSync(join(config, "hosts.json"), "utf8")).hosts;
  const url = hosts.find(host => host.roles?.chat?.url)?.roles.chat.url;
  if (!url) throw new Error("No host in hosts.json has roles.chat.url.");
  const { capability } = JSON.parse(readFileSync(join(config, "chat-access.json"), "utf8"));
  return `${new URL(url).origin}/${capability}/`;
}

const url = chatUrl();
// Chrome names the new bundle "Prime Agent chat 1" while an older one holds the name, so app bundles for any other chat URL go first,
// such as the one for http://127.0.0.1:5182 from before the chat moved to us-metal02 on 10-18.
const APPS = join(homedir(), "Applications/Chrome Apps.localized");
const plist = (bundle, key) => { try { return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim(); } catch { return null; } };
let bundles = [];
try { bundles = readdirSync(APPS).filter(name => name.endsWith(".app")); } catch { /* no Chrome apps yet */ }
for (const name of bundles) {
  const bundle = join(APPS, name), opens = plist(bundle, "CrAppModeShortcutURL");
  if (plist(bundle, "CrAppModeShortcutName") === "Prime Agent chat" && opens !== url) {
    rmSync(bundle, { recursive: true, force: true });
    console.error(`Removed ${name}, which opened ${opens?.replace(/[0-9a-f]{64}/, "<capability>")}.`);
  }
}
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
chrome.on("exit", code => { if (!done) { console.error(`Chrome exited (${code}) before the install finished. Quit the chat app and run this again.`); process.exit(1); } });
let done = false, next = 1, buffer = "";
const waiting = new Map();
chrome.stdio[4].on("data", data => {
  buffer += data.toString();
  for (let end; (end = buffer.indexOf("\0")) >= 0; buffer = buffer.slice(end + 1)) {
    const message = JSON.parse(buffer.slice(0, end));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = next++;
  waiting.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function attach(targetId) { return (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId; }
async function evaluate(session, expression) { return (await send("Runtime.evaluate", { expression, returnByValue: true }, session)).result.value; }
async function waitFor(session, expression, ms = 90000) {
  for (const start = Date.now(); Date.now() - start < ms; await sleep(250)) if (await evaluate(session, expression).catch(() => false)) return true;
  return false;
}

try {
  const pageTarget = (await send("Target.createTarget", { url })).targetId;
  const page = await attach(pageTarget);
  if (!await waitFor(page, "document.readyState === 'complete' && !!document.querySelector('link[rel=manifest]')")) throw new Error(`${url} did not load the chat page.`);
  const { installabilityErrors } = await send("Page.getInstallabilityErrors", {}, page);
  if (installabilityErrors.length) throw new Error("Chrome cannot install the page: " + JSON.stringify(installabilityErrors));
  // The manifest id "./" resolves against the start URL's origin, so the id is the origin root, not the capability URL.
  const { appId: manifestId } = await send("Page.getAppId", {}, page);
  await send("PWA.install", { manifestId }, page);
  await send("Target.closeTarget", { targetId: pageTarget });
  await send("PWA.launch", { manifestId });
  await sleep(2000);
  // The launch answers with the window's tab target; the page under it is the one that runs scripts.
  const { targetInfos } = await send("Target.getTargets");
  const appPage = targetInfos.find(info => info.type === "page" && info.url.startsWith(new URL(url).origin));
  if (!appPage) throw new Error("The app window did not open.");
  const app = await attach(appPage.targetId);
  // The thread list streams in after the page loads; wait until its first rows show.
  const shown = await waitFor(app, "document.body.innerText.trim().length > 200 && !document.querySelector('aside .animate-spin, nav .animate-spin')") &&
    await waitFor(app, "document.body.innerText.trim().split('\\n').length > 40");
  console.log(JSON.stringify({ installed: url.replace(/[0-9a-f]{64}/, "<capability>"), title: await evaluate(app, "document.title"), shown }));
  const screenshot = option("--screenshot");
  if (screenshot) writeFileSync(screenshot, Buffer.from((await send("Page.captureScreenshot", { format: "png" }, app)).data, "base64"));
} finally {
  done = true;
  await send("Browser.close").catch(() => {});
  setTimeout(() => { chrome.kill(); process.exit(process.exitCode ?? 0); }, 2000);
}
