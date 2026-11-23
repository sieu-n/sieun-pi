import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { AUTHORIZE_REST_MS, CLI_KEY, dueAccounts, parseRenewal, readAuthorizePage, RENEW_LEAD_MS, type RenewalState, type RenewResult, renewalStateFile, type PoolRow } from "../src/claude-grant-renewal.ts";
import { parsePrompts, type PromptKind, promptsText, signInPromptsFile, withPrompt } from "../src/sign-in-prompts.ts";

/**
 * Signs each pi-pool Claude account, and the box claude CLI, in again before its refresh grant reaches its fixed end
 * (src/claude-grant-renewal.ts). The Komodo Procedure m02-claude-grant-renew runs it on us-metal02 every 3 h:
 * `node --import tsx scripts/claude-grant-renew.ts [--dry-run] [--only <email|claude-cli>]`.
 * Each sign-in is the one d5 jobs did by hand (p1552, 11-15): `pi-pool login <email> --provider anthropic` or `claude auth login`, its URL
 * opened in the owner's Aside through `aside mcp`, claude.ai's email link read from his Gmail, and Authorize clicked once its hCaptcha lets
 * the button go. A password, 2FA, passkey or payment page is recorded with the sign-in prompts (src/sign-in-prompts.ts), which makes it the
 * owner's item and stops later runs from trying again.
 */

const HOME = homedir();
const log = (text: string) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const minute = (ms: number) => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;

class Prompted extends Error { constructor(readonly kind: PromptKind, readonly where: string) { super(`reached a ${kind} prompt on ${where}`); } }
class Offline extends Error {}

function exec(file: string, args: readonly string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", error => { clearTimeout(timer); resolve({ code: 127, out: String(error) }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 124, out }); });
  });
}

type Reply = { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };

/** One `aside mcp` server for the whole run, so the REPL keeps its tab between calls. */
class AsideRepl {
  private child = spawn(process.env.ASIDE_CLI || join(HOME, ".local/bin/aside"), ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  private waiting = new Map<number, (message: Reply) => void>();
  private next = 1;
  private stderr = "";
  constructor() {
    let buffer = "";
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const message = JSON.parse(line); this.waiting.get(message.id)?.(message); this.waiting.delete(message.id); } catch { /* not a reply */ }
      }
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-600); });
    this.child.on("close", () => { for (const done of this.waiting.values()) done({ error: { message: `aside mcp exited: ${this.stderr.trim()}` } }); this.waiting.clear(); });
  }
  private request(method: string, params: object, timeoutMs: number) {
    const id = this.next++;
    return new Promise<Reply>(resolve => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ error: { message: `${method} took over ${timeoutMs} ms` } }); }, timeoutMs);
      this.waiting.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async open(): Promise<void> {
    const reply = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-grant-renew", version: "1" } }, 40_000);
    if (reply.error) throw new Offline(`aside mcp did not start: ${reply.error.message}`);
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  /** Runs `body` as an async function in Aside's REPL, which allows 120 s a call, and returns what it logged. */
  async run(body: string): Promise<string> {
    const reply = await this.request("tools/call", { name: "repl", arguments: { title: "claude-grant-renew", code: `await (async () => {\n${body}\n})();` } }, 130_000);
    const text = reply.result?.content?.map(block => block.text ?? "").join("\n") ?? "";
    if (reply.error || reply.result?.isError) {
      const message = reply.error?.message ?? text;
      if (/not connected to the daemon|exited|Connection closed|ssh|isn't running/i.test(message)) throw new Offline(message.slice(0, 300));
      throw new Error(`Aside REPL: ${message.slice(0, 400)}`);
    }
    return text;
  }
  close(): void { this.child.stdin.end(); setTimeout(() => this.child.kill(), 2_000).unref(); }
}

const READ = "const rt = globalThis.renewTab; console.log(JSON.stringify({ url: rt.url(), text: (await rt.locator('body').innerText()).slice(0, 3000) }));";
async function read(repl: AsideRepl): Promise<{ url: string; text: string }> {
  const out = await repl.run(READ);
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { url: string; text: string };
}
const js = (value: string) => JSON.stringify(value);

function promptOn(page: { url: string; text: string }): Prompted | undefined {
  if (/subscription is paused|Pay your invoice/i.test(page.text)) return new Prompted("payment", `claude.ai's "Your subscription is paused" page at ${page.url.slice(0, 80)}`);
  if (/passkey/i.test(page.text)) return new Prompted("passkey", page.url.slice(0, 80));
  if (/enter your password|^password$/im.test(page.text)) return new Prompted("password", page.url.slice(0, 80));
  if (/two-factor|authenticator app|2-step/i.test(page.text)) return new Prompted("2fa", page.url.slice(0, 80));
  return undefined;
}

/**
 * Every claude.ai sign-in link in the owner's Gmail, which gets every slack.green address, sent to `email` in the last 30 min. It reads through
 * Aside's `gmail` helper, and when that fails through a Gmail search tab and each thread's print view: from 05:42Z on 11-17 the helper's
 * search answered "/i/bv failed: HTTP 400" for every query while Gmail's own pages loaded.
 */
async function magicLinks(repl: AsideRepl, email: string): Promise<string[]> {
  const query = `to:${email} newer_than:30m subject:"secure link"`;
  const out = await repl.run(`const query = ${js(query)}; const pattern = /https:\\/\\/claude\\.ai\\/magic-link#[^\\s)\\]"'<>&]+/g; const links = [];
try {
  const found = await gmail.search(0, query);
  for (const hit of found.results.slice(0, 10)) { const thread = await gmail.getThread(0, hit.threadId); for (const message of thread.messages) links.push(...[...message.body.matchAll(pattern)].map(m => m[0])); }
} catch {
  const searchTab = await openTab('https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(query)); await sleep(6000);
  try {
    const ids = await searchTab.evaluate(() => [...document.querySelectorAll('[data-legacy-thread-id]')].map(row => row.getAttribute('data-legacy-thread-id')));
    for (const id of [...new Set(ids)].slice(0, 10)) links.push(...[...(await (await fetch('https://mail.google.com/mail/u/0/?ui=2&view=pt&search=all&th=' + id)).text()).matchAll(pattern)].map(m => m[0]));
  } finally { await closeTab(searchTab); }
}
console.log("LINKS " + JSON.stringify([...new Set(links)]));`);
  const line = out.split("\n").find(row => row.startsWith("LINKS "));
  if (!line) throw new Error(`Gmail gave no link list: ${out.slice(0, 200)}`);
  return JSON.parse(line.slice(6)) as string[];
}

/** The sign-in link claude.ai sent after `before` was read: on 11-16 the newest Gmail thread held an older, spent link, which said "This link has expired". */
async function newMagicLink(repl: AsideRepl, email: string, before: ReadonlySet<string>): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const fresh = (await magicLinks(repl, email)).filter(link => !before.has(link));
    if (fresh.length) return fresh[0]!;
    await sleep(8_000);
  }
  // Only slack.green mail reaches the owner's Gmail. krenerd77@naver.com's link lands in Naver mail, which his Aside is not signed in to
  // (mail.naver.com answered 302 to nid.naver.com's login on 11-16), so only his Naver password lets it in.
  const domain = email.split("@")[1] ?? "";
  if (domain !== "slack.green") throw new Prompted("password", `${domain} mail, which gets ${email}'s claude.ai link and which the owner's Aside is not signed in to`);
  throw new Error(`no new claude.ai sign-in link for ${email} reached the owner's Gmail within about 2 min`);
}

/**
 * Signs the tab in `repl.renewTab`, on a claude.ai login page or a page "Logged in as" another account, in as `email` through claude.ai's email
 * link, and returns the page the link opened.
 */
async function emailSignIn(repl: AsideRepl, email: string): Promise<{ url: string; text: string }> {
  const page = await read(repl);
  if (page.text.includes("Logged in as")) await repl.run("await globalThis.renewTab.getByText('Switch account').click(); await sleep(3000);");
  const before = new Set(await magicLinks(repl, email));
  // The login page can take longer than the 4 s after openTab to draw its form: at 19:35Z on 11-23 the restore found neither the email box
  // nor "Continue with email", and the same page drew both when read again later.
  const form = await repl.run(`const lt = globalThis.renewTab; const box = lt.getByRole('textbox', { name: 'Email' });
for (let i = 0; i < 30 && !(await box.isVisible().catch(() => false)); i++) {
  const more = lt.getByText('Continue with email').first();
  if (await more.isVisible().catch(() => false)) await more.click();
  await sleep(1000);
}
if (!(await box.isVisible().catch(() => false))) { console.log('NOFORM'); return; }
await box.click(); await lt.keyboard.type(${js(email)}, { delay: 40 }); await sleep(700);
await lt.getByRole('button', { name: 'Continue with email' }).click(); await sleep(6000);`);
  if (form.includes("NOFORM")) { const shown = await read(repl); throw promptOn(shown) ?? new Error(`claude.ai's login page showed no email box within 30 s: ${shown.text.slice(0, 300)}`); }
  const sent = await read(repl);
  if (!/link sent to/i.test(sent.text)) throw promptOn(sent) ?? new Error(`claude.ai sent no sign-in link: ${sent.text.slice(0, 300)}`);
  const link = await newMagicLink(repl, email, before);
  await repl.run(`await globalThis.renewTab.goto(${js(link)}); await sleep(7000);`);
  return read(repl);
}

const closeRenewTab = (repl: AsideRepl) => repl.run("if (globalThis.renewTab) { await closeTab(globalThis.renewTab); globalThis.renewTab = undefined; }").catch(() => undefined);

/** Approves the authorize URL for `email` in the owner's Aside and returns the code claude.ai shows to paste. */
async function approve(repl: AsideRepl, url: string, email: string): Promise<string> {
  await repl.run(`globalThis.renewTab = await openTab(${js(url)}); await sleep(4000);`);
  try {
    let page = await read(repl);
    if (!page.text.includes(`Logged in as ${email}`)) {
      page = await emailSignIn(repl, email);
      if (!page.text.includes(`Logged in as ${email}`)) throw promptOn(page) ?? new Error(`the sign-in link did not reach the Authorize page as ${email}: ${page.text.slice(0, 300)}`);
    }
    // The Authorize button stays disabled until claude.ai's hCaptcha passes, which a reload and mouse moves bring about (11-16). Since 11-23 the
    // page also ignores a press that lands within 400 to 700 ms of the pointer entering it, and says "Too soon. Wait, then press again.", which
    // a mouse.click that moves in and presses at once always did. So the pointer rests on the button for AUTHORIZE_REST_MS before it presses.
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await repl.run(`const at = globalThis.renewTab; await at.reload(); await sleep(3000);
if (!(await at.locator('body').innerText()).includes(${js(`Logged in as ${email}`)})) { console.log('WRONG'); return; }
const button = at.getByRole('button', { name: 'Authorize' });
for (let i = 0; i < 60; i++) {
  if (await button.isEnabled()) {
    const box = await button.boundingBox(); await at.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 }); await sleep(${AUTHORIZE_REST_MS});
    if (await button.isEnabled()) { await at.mouse.down(); await sleep(90); await at.mouse.up(); await sleep(6000); console.log('CLICKED'); return; }
  }
  await at.mouse.move(250 + (i % 9) * 31, 280 + (i % 6) * 27, { steps: 5 }); await sleep(700);
}
console.log('DISABLED');`);
      if (out.includes("WRONG")) throw new Error(`another sign-in switched the owner's claude.ai to a different account before Authorize`);
      if (!out.includes("CLICKED")) continue;
      page = await read(repl);
      const shown = readAuthorizePage(page.text);
      if (shown.kind === "code") return shown.code;
      if (shown.kind === "too-soon") continue;
      throw promptOn(page) ?? new Error(`Authorize gave no code: ${page.text.slice(0, 300)}`);
    }
    throw new Error("the Authorize button stayed disabled, or the page called each press too soon, through 3 reloads");
  } finally {
    await closeRenewTab(repl);
  }
}

/**
 * Signs the owner's Aside back in to claude.ai as `holder`, the account it held before the run, or leaves it signed out when it held none,
 * since each renewal's sign-in replaces his claude.ai login there and Aside has one profile with one cookie jar. claude.ai's sign-out is a
 * POST to /api/auth/logout with his cookies; its /login?from=logout page did not sign out on 11-16.
 */
async function restoreHolder(repl: AsideRepl, holder: string): Promise<void> {
  await repl.run("await fetch('https://claude.ai/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });");
  if (holder.includes("@")) {
    await repl.run("globalThis.renewTab = await openTab('https://claude.ai/login'); await sleep(4000);");
    try { await emailSignIn(repl, holder); } finally { await closeRenewTab(repl); }
  }
  const now = await claudeAiHolder(repl);
  if (now !== holder) throw new Error(`claude.ai in Aside holds ${now} after the restore`);
}

/** A sign-in process that prints an authorize URL and reads the code on stdin. */
function signIn(file: string, args: readonly string[], urlOf: (out: string) => string | undefined, enter: string) {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const exited = new Promise<number>(resolve => child.on("close", code => resolve(code ?? 1)));
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { out += chunk; });
  return {
    async url(): Promise<string> {
      for (let i = 0; i < 60; i++) { const url = urlOf(out); if (url) return url; await sleep(500); }
      child.kill(); throw new Error(`${file} printed no sign-in URL: ${out.slice(-300)}`);
    },
    async finish(code: string): Promise<string> {
      child.stdin.write(code + enter);
      const ended = await Promise.race([exited, sleep(60_000).then(() => undefined)]);
      if (ended === undefined) child.kill();
      return out;
    },
    stop(): void { child.kill(); },
  };
}

/** The account the owner's Aside holds claude.ai with, read with his cookies and no tab, or "signed out". */
async function claudeAiHolder(repl: AsideRepl): Promise<string> {
  const out = await repl.run("const answer = await fetch('https://claude.ai/api/account'); console.log(answer.status === 200 ? (await answer.json()).email_address : 'signed out');");
  const holder = out.trim().split("\n").at(-1) ?? "";
  if (!holder.includes("@") && holder !== "signed out") throw new Error(`claude.ai's account read gave ${out.slice(0, 120)}`);
  return holder;
}

async function grantOf(file: string): Promise<number | undefined> {
  try {
    const at = (JSON.parse(await readFile(file, "utf8")) as { claudeAiOauth?: { refreshTokenExpiresAt?: unknown } }).claudeAiOauth?.refreshTokenExpiresAt;
    return typeof at === "number" ? at : undefined;
  } catch { return undefined; }
}
const poolDir = () => process.env.PI_POOL_DIR || join(HOME, ".config/pi-pool");
const poolGrant = (id: string) => grantOf(join(poolDir(), "accounts/secrets", `pi-pool.anthropic.${id}`));
const CLI_CREDENTIALS = join(HOME, ".claude/.credentials.json");

async function renewPool(repl: AsideRepl, id: string, email: string, before: number | undefined): Promise<number> {
  const login = signIn("pi-pool", ["login", email, "--provider", "anthropic"], out => {
    const line = out.split("\n").find(row => row.includes('"manual_url"'));
    return line ? (JSON.parse(line) as { manual_url?: string }).manual_url : undefined;
  }, "\n");
  try {
    const code = await approve(repl, await login.url(), email);
    const out = await login.finish(code);
    if (!/"event": ?"done", ?"ok": ?true/.test(out)) throw new Error(`pi-pool login did not finish: ${out.split("\n").filter(Boolean).at(-1)?.slice(0, 300)}`);
  } finally { login.stop(); }
  const after = await poolGrant(id);
  if (after === undefined || after === before || after - Date.now() <= RENEW_LEAD_MS) throw new Error(`pi-pool saved no new grant end (${after === undefined ? "none" : minute(after)})`);
  return after;
}

async function renewCli(repl: AsideRepl, email: string, before: number | undefined): Promise<number> {
  const login = signIn("script", ["-qfc", "claude auth login", "/dev/null"], out => /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\x07\x1b\s\]]+/.exec(out)?.[0], "\r");
  try {
    await login.finish(await approve(repl, await login.url(), email));
  } finally { login.stop(); }
  const status = await exec("claude", ["auth", "status"]);
  if (!/"loggedIn": ?true/.test(status.out)) throw new Error(`claude auth status after the sign-in: ${status.out.slice(0, 300)}`);
  const after = await grantOf(CLI_CREDENTIALS);
  if (after === undefined || after === before || after - Date.now() <= RENEW_LEAD_MS) throw new Error(`the CLI saved no new grant end (${after === undefined ? "none" : minute(after)})`);
  return after;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, only: { type: "string" } } });
  const now = Date.now();
  const stateFile = renewalStateFile(HOME);
  const state: RenewalState = parseRenewal(await readFile(stateFile, "utf8").catch(() => undefined)) ?? { ranAt: new Date(0).toISOString(), results: {} };
  const listed = await exec("pi-pool", ["ls", "--json", "--provider", "anthropic"]);
  if (listed.code !== 0) throw new Error(`pi-pool ls: ${listed.out.slice(0, 300)}`);
  const rows = (JSON.parse(listed.out) as { rows?: PoolRow[] }).rows ?? [];
  const ends = new Map<string, number>();
  for (const row of rows) { const end = row.id ? await poolGrant(row.id) : undefined; if (end !== undefined) ends.set(row.id!, end); }
  const orgs = new Map<string, string>();
  try {
    for (const account of (JSON.parse(await readFile(join(poolDir(), "accounts/anthropic.json"), "utf8")) as { accounts?: { id?: string; oauthAccount?: { organizationUuid?: string } }[] }).accounts ?? []) {
      if (account.id && account.oauthAccount?.organizationUuid) orgs.set(account.id, account.oauthAccount.organizationUuid);
    }
  } catch { /* no index */ }
  const promptsPath = signInPromptsFile(HOME);
  let prompts = parsePrompts(await readFile(promptsPath, "utf8").catch(() => undefined));
  const prompted = new Set(prompts.filter(row => row.provider === "anthropic").map(row => row.account.toLowerCase()));
  const only = values.only?.toLowerCase();
  type Job = { key: string; email: string; why: string; run: (repl: AsideRepl) => Promise<number> };
  const jobs: Job[] = (only && only !== CLI_KEY
    ? rows.filter(row => row.email?.toLowerCase() === only && row.id).map(row => ({ id: row.id!, email: row.email!, why: "named with --only", ...(ends.has(row.id!) ? { end: ends.get(row.id!)! } : {}) }))
    : only ? [] : dueAccounts(rows, ends, orgs, prompted, now))
    .map(account => ({ key: account.email.toLowerCase(), email: account.email, why: account.why, run: (repl: AsideRepl) => renewPool(repl, account.id, account.email, account.end) }));
  if (!only || only === CLI_KEY) {
    const status = await exec("claude", ["auth", "status"]);
    const cliEmail = /"email": ?"([^"]+)"/.exec(status.out)?.[1] ?? state.results[CLI_KEY]?.email;
    const end = await grantOf(CLI_CREDENTIALS);
    const loggedIn = /"loggedIn": ?true/.test(status.out);
    if (cliEmail && (only === CLI_KEY || !loggedIn || (end !== undefined && end - now <= RENEW_LEAD_MS))) {
      jobs.push({ key: CLI_KEY, email: cliEmail, why: loggedIn ? `CLI grant ends ${end === undefined ? "?" : minute(end)}` : "CLI signed out", run: repl => renewCli(repl, cliEmail, end) });
    } else if (!cliEmail) log("the claude CLI is signed out and no earlier run recorded its account, so it is left to d5's claude_cli check");
  }
  log(`${jobs.length} due: ${jobs.map(job => `${job.email} (${job.why})`).join(", ") || "none"}`);
  if (values["dry-run"]) return;
  const record = (job: Job, result: Omit<RenewResult, "at" | "email">) => { state.results[job.key] = { at: new Date().toISOString(), email: job.email, ...result }; log(`${job.email}: ${result.outcome} ${result.detail}`); };
  let repl: AsideRepl | undefined;
  let offline: string | undefined;
  // The account to leave claude.ai in Aside with: one an earlier run failed to restore, else the one it holds now.
  let holder = state.restoreTo;
  if (jobs.length || holder) {
    try {
      repl = new AsideRepl(); await repl.open();
      holder ??= await claudeAiHolder(repl);
      log(`claude.ai in the owner's Aside holds ${holder} before the run`);
    } catch (error) { offline = (error as Error).message.slice(0, 300); }
  }
  for (const job of jobs) {
    if (offline || !repl) { record(job, { outcome: "mac-offline", detail: offline ?? "no Aside" }); continue; }
    try {
      const end = await job.run(repl);
      record(job, { outcome: "renewed", grantEnd: end, detail: `grant now ends ${minute(end)}` });
    } catch (error) {
      if (error instanceof Offline) { offline = error.message; record(job, { outcome: "mac-offline", detail: offline }); continue; }
      if (error instanceof Prompted) {
        prompts = withPrompt(prompts, { provider: "anthropic", account: job.email, prompt: error.kind, at: new Date().toISOString(), where: error.where, evidence: `claude-grant-renew journal at ${new Date().toISOString()}` });
        await writeFile(`${promptsPath}.tmp`, promptsText(prompts)); await rename(`${promptsPath}.tmp`, promptsPath);
        record(job, { outcome: "prompt", detail: error.message });
        continue;
      }
      record(job, { outcome: "failed", detail: (error as Error).message.slice(0, 400) });
    }
  }
  if (repl && holder && !offline) {
    try {
      const now = await claudeAiHolder(repl);
      if (now !== holder) { await restoreHolder(repl, holder); log(`signed claude.ai in the owner's Aside back in as ${holder}`); }
      delete state.restoreTo;
    } catch (error) {
      state.restoreTo = holder;
      log(`could not sign claude.ai in the owner's Aside back in as ${holder}, so the next run tries again: ${(error as Error).message.slice(0, 300)}`);
      // A sign-in that failed must not leave his Aside on a pool account when it did not start on one.
      const pool = new Set(rows.flatMap(row => row.email ? [row.email.toLowerCase()] : []));
      if (!pool.has(holder.toLowerCase())) await restoreHolder(repl, "signed out").catch(signOut => log(`the sign-out failed too: ${(signOut as Error).message.slice(0, 200)}`));
    }
  } else if (holder && offline) state.restoreTo = holder;
  repl?.close();
  state.ranAt = new Date().toISOString();
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${stateFile}.tmp`, stateFile);
}

await main().then(() => process.exit(0), error => { log(`claude-grant-renew: ${(error as Error).stack ?? error}`); process.exit(1); });
