import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BoxBrowser } from "./box-browser.ts";
import { REPO } from "./estate-reads.ts";
import { OWNER_ORG, STAGING_OWNER_ORG } from "./watchlist-green.ts";

/**
 * d2's daily Watchlist screenshot (`node --import tsx scripts/duties/watchlist-green-shot.ts [prod|staging ...]`). It signs a box Chrome in to
 * virev.ai as the Watchlist owner org's admin test account with a Clerk sign-in token, opens /app/watchlist, saves a PNG and prints the status
 * chip tones of the rows on screen. On 11-04 at 13:19 KST d2 took the shot in the owner's Aside, where virev.ai had fallen back to sign-in and
 * the saved password answered "Password is incorrect", so the duty never reads or types his login again (c109, c204). The Clerk secret comes
 * from apps/vent's dotenvx env, the only env that holds the prod sk_live_ key, and the session the ticket made is revoked at the end.
 */

export interface ShotEnv { name: "prod" | "staging"; base: string; envFile: string; orgId: string }
export const ENVS: Record<ShotEnv["name"], ShotEnv> = {
  prod: { name: "prod", base: "https://virev.ai", envFile: "apps/vent/.env", orgId: OWNER_ORG },
  staging: { name: "staging", base: "https://staging.virev.ai", envFile: "apps/vent/.env.staging", orgId: STAGING_OWNER_ORG },
};
/** The admin test account of both owner orgs; the owner's own account is never signed in. */
export const SHOT_EMAIL = "test@konti.bot";
export const SHOT_DIR = join(homedir(), "work/watchlist-green/shots");

const CLERK = "https://api.clerk.com/v1";

async function clerk<T>(fetcher: typeof fetch, secret: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetcher(`${CLERK}${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Clerk ${init.method ?? "GET"} ${path.split("?")[0]} answered HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as T;
}

/** A one-time sign-in ticket for SHOT_EMAIL, refused unless that user belongs to the org the shot reads. */
export async function signInTicket(fetcher: typeof fetch, secret: string, orgId: string): Promise<{ id: string; token: string; userId: string }> {
  const users = await clerk<{ id: string }[]>(fetcher, secret, `/users?email_address=${encodeURIComponent(SHOT_EMAIL)}`);
  if (users.length !== 1) throw new Error(`Clerk has ${users.length} users with the email ${SHOT_EMAIL}`);
  const userId = users[0]!.id;
  const orgs = await clerk<{ data: { organization: { id: string } }[] }>(fetcher, secret, `/users/${userId}/organization_memberships?limit=100`);
  if (!orgs.data.some(row => row.organization.id === orgId)) throw new Error(`${SHOT_EMAIL} (${userId}) is not a member of ${orgId}`);
  const ticket = await clerk<{ id: string; token: string }>(fetcher, secret, "/sign_in_tokens", { method: "POST", body: JSON.stringify({ user_id: userId }) });
  return { id: ticket.id, token: ticket.token, userId };
}

export interface ShotRead { url?: string; orgId?: string; sessionId?: string; tones: Record<string, number>; notGreen: string[]; error?: string }

/** The shot is good when the page is the Watchlist of the org it should read and at least one row shows the green tracking chip. */
export function shotProblem(read: ShotRead, env: ShotEnv): string | null {
  if (read.error) return read.error;
  if (!read.url || new URL(read.url).pathname !== "/app/watchlist") return `the page ended on ${read.url ?? "no url"}, not /app/watchlist`;
  if (read.orgId !== env.orgId) return `the session reads org ${read.orgId ?? "none"}, not ${env.orgId}`;
  if (!read.tones.tracking) return `no row shows the green tracking chip (${JSON.stringify(read.tones)})`;
  return null;
}

/** Box runner code: sign in by ticket, switch to the org, open the Watchlist, wait for its chips and save the screenshot. */
export function shotCode(env: ShotEnv, token: string, path: string): string {
  return `
const p = await openTab();
const read = { tones: {}, notGreen: [] };
try {
  await p.goto(${JSON.stringify(`${env.base}/sign-in?__clerk_ticket=`)} + ${JSON.stringify(token)}, { waitUntil: "load", timeout: 60000 });
  await p.waitForURL(u => new URL(String(u)).pathname.startsWith("/app"), { timeout: 60000 });
  await p.waitForFunction(() => window.Clerk && window.Clerk.session, null, { timeout: 30000 });
  await p.evaluate(async orgId => { if (window.Clerk.organization?.id !== orgId) await window.Clerk.setActive({ organization: orgId }); }, ${JSON.stringify(env.orgId)});
  await p.goto(${JSON.stringify(`${env.base}/app/watchlist`)}, { waitUntil: "load", timeout: 60000 });
  try { await p.waitForFunction(() => document.querySelector("main [data-status]:not([data-status=loading])"), null, { timeout: 60000 }); } catch {}
  await sleep(5000);
  await p.screenshot({ path: ${JSON.stringify(path)} });
  Object.assign(read, await p.evaluate(() => {
    const cells = [...document.querySelectorAll("main [data-status]")];
    const tones = {};
    for (const cell of cells) tones[cell.dataset.status] = (tones[cell.dataset.status] || 0) + 1;
    const notGreen = cells.filter(cell => !["tracking", "loading"].includes(cell.dataset.status)).map(cell => cell.querySelector("[aria-label]")?.getAttribute("aria-label") || cell.dataset.status);
    return { url: location.href, orgId: window.Clerk.organization?.id, sessionId: window.Clerk.session?.id, tones, notGreen };
  }));
} catch (e) { read.error = String(e && e.message || e).split("\\n")[0]; read.url = p.url(); }
await p.close();
console.log(JSON.stringify(read));`;
}

async function shoot(browser: BoxBrowser, env: ShotEnv, stamp: string): Promise<{ env: string; path: string; problem: string | null; read: ShotRead }> {
  const { stdout } = await promisify(execFile)(join(REPO, "node_modules/.bin/dotenvx"), ["get", "CLERK_SECRET_KEY", "-f", join(REPO, env.envFile)]);
  const secret = stdout.trim();
  const ticket = await signInTicket(fetch, secret, env.orgId);
  const path = join(SHOT_DIR, `${env.name}-${stamp}.png`);
  try {
    // measured: on 11-04 the ticket sign-in took under 8 s and the prod Watchlist drew its chips within 15 s of load in the box Chrome.
    const out = await browser.run(shotCode(env, ticket.token, path), 240_000);
    const read = JSON.parse(out.trim().split("\n").at(-1)!) as ShotRead;
    if (read.sessionId) await clerk(fetch, secret, `/sessions/${read.sessionId}/revoke`, { method: "POST" });
    return { env: env.name, path, problem: shotProblem(read, env), read };
  } finally {
    await clerk(fetch, secret, `/sign_in_tokens/${ticket.id}/revoke`, { method: "POST" }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ["prod", "staging"];
  const envs = names.map(name => { const env = ENVS[name as ShotEnv["name"]]; if (!env) throw new Error(`unknown env ${name}; use prod or staging`); return env; });
  await mkdir(SHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const browser = BoxBrowser.start();
  let failed = false;
  try {
    for (const env of envs) {
      const shot = await shoot(browser, env, stamp).catch((error: unknown) => ({ env: env.name, path: "", problem: error instanceof Error ? error.message : String(error), read: undefined }));
      failed ||= shot.problem !== null;
      process.stdout.write(JSON.stringify(shot) + "\n");
    }
  } finally { await browser.close(); }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
