import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type DutyMetric, type FlaggedSlice, OUTSIDE_WAIT, type PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { boxExit, type BrowserJar, crawlerJars, type HeldJar, type ReadJar, waitForOtherRuns } from "./dm-extension.ts";
import { DAY, REPO, settle, SOURCE_DEADLINE_MS, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The chrome extension chat's "DM extension on prod" precheck (`node --import tsx scripts/duties/dm-store-prod.ts`), duty d3. No model call.
 * d1 checks staging with the dev build of today's tree and one sender; this checks what a member installs, on production, with two
 * Instagram accounts in one Chrome (owner 10-28: "실제 왔다갔다 conversation render되는지 잘 확인해" and "동일 클라이언트 부계정 usecase도 돼야됨").
 * 1. It downloads the Chrome Web Store's current CRX of the extension and unpacks it with the store's public key as the manifest key, so
 *    Chromium loads it under the store id STORE_ID, the same files and id a member's install has.
 * 2. It reads both test accounts' saved sessions and exits from the crawler (BROWSER_JAR, dm-extension.ts jarReader), holding them in the
 *    roles dm-extension-store-a and -b. A held jar or a box exit opens no browser (owner rule c229) and the run waits on the proxy.
 * 3. It runs auto-sns-agent apps/dm-extension/tests/multi-account-real-ig.mjs on virev.ai in the kept prod workspace ORG as the e2e user:
 *    one Chrome with the store build, A signed in. The rig unlinks both accounts in the org first, waits for the signed-in tab to pair the
 *    extension with no click, presses Link for A, switches the Chrome to B on instagram.com and presses Link for B, switches back to A,
 *    and queues one DM from each account to the other from Connections. Each must settle sent from its own account while A stays in
 *    front, and each must land in the other account's Inbox thread and show on its Inbox page. The rig sweeps its device and any unsent
 *    DM when it ends (lib/rig-cleanup.mjs). One run sends one DM from each account, and no account of d1 (279, 33) is used here.
 * 4. It revokes the Clerk sessions the rig's virev sign-in opened, and reads prod searchDmMessages for every org's extension send
 *    failures of the 24 h before it.
 *
 * The duty's timeoutMs of 3,600 s is its soft target. measured: the first run (11-25 21:00Z to 21:31Z) took 1,870 s, 720 s of it the rig's full
 * reply wait after B's send was lost, and the rig's send wait can run 1,200 s on a slow exit (multi-account-real-ig.mjs SEND_WAIT_MS).
 *
 * Targets in dm-store-prod.duty.json:
 * - prod_store_e2e_pass >= 1: the owner's done line for the extension on prod (chrome extension brief, "What done means").
 * - two_accounts_pass >= 1: the second account in the same Chrome works as the first does.
 * - prod_send_failures_24h <= 0: a prod extension DM a customer or the rig queued that settled failed, delivery_unknown or
 *   send_restricted. A row the queue cancelled before it was sent (errorCode cancelled) is no send failure.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DUTY_FILE = join(HERE, "dm-store-prod.duty.json");
/** The Chrome Web Store item "virev DM sender". */
export const STORE_ID = "jcoaoifnchpadejdimobidgoglimgfkd";
/** The store's CRX download for STORE_ID. prodversion names the asking Chrome, and the store serves the current CRX to any version at or
 *  above the manifest's minimum_chrome_version (none in 2.0.6). */
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0.0.0&acceptformat=crx3&x=id%3D${STORE_ID}%26uc`;
/**
 * A is @aoi.otoha (prod engage 21) and B @rinayui37 (prod 18), both of the clean Q5N5 lot with no box history. Each had seller logins,
 * which a password change with "Log out of other devices" removed (21 on 11-26, 18 on 11-26 by this duty's build job), and they follow
 * each other. d1 uses 279 and 33, so each test account sends at most one DM a day: every test sender of 11-24 that sent more was
 * limited by Instagram within an hour (wiki agents/chrome-extension/jobs/2026/11/25/0007-dm-test-sender-limits).
 */
export const ACCOUNT_A = "aoi.otoha";
export const ACCOUNT_B = "rinayui37";
/** The kept prod workspace "My workspace" and its e2e user, a +clerk_test@konti.bot user that prod Vent's e2e-prod-reader caller may sign in. */
export const ORG = "org_3LYsD8y8wCIQoX4xDO1dF7Klfvp";
export const EMAIL = "dm-ext-e2e+clerk_test@konti.bot";
export const PROD_DEPLOYMENT = "convex-prod";
/** measured: `convex data` returned 16,384 rows and refused 50,001 on 10-30; prod searchDmMessages held 1,545 rows on 11-26. */
export const ROWS_LIMIT = 16_384;
const OUT = join(REPO, ".cache/duties/dm-store-prod/latest");

export type Part = "pair" | "link" | "sent" | "reply";
export type SecondPart = "found" | "link" | "sent" | "reply" | "front";
export const PARTS: Readonly<Record<Part, string>> = {
  pair: "the signed-in virev.ai tab paired the store build with no click",
  link: "the popup's Link press joined account A to the workspace",
  sent: "A's DM enqueued from Connections settled sent from A",
  reply: "B's DM to A landed in A's Inbox thread and shows on its Inbox page",
};
export const SECOND_PARTS: Readonly<Record<SecondPart, string>> = {
  found: "the extension found account B after the Chrome switched to it",
  link: "the popup's Link press joined account B to the workspace",
  sent: "B's DM settled sent from B while A stayed in front",
  reply: "A's DM to B landed in B's own Inbox thread and shows on its Inbox page",
  front: "A was the account in front of the Chrome after both sends",
};

/** A searchDmMessages row as the rig's `brief` writes it. */
export interface Brief { id: string; status: string; account: string | null; sender: string | null; thread: string | null; errorCode: string | null }
/** The multi-account rig's evidence.json. */
export interface RigEvidence {
  unlinkedBefore?: string[];
  paired?: { deviceId: string | null; ms: number; status: string | null; version: string | null };
  linkA?: { already: boolean; ms: number };
  linkB?: { already: boolean; ms: number };
  bNamed?: { front?: string; frontHandle?: string } | null;
  sentA?: Brief | null;
  sentB?: Brief | null;
  incomingInA?: Brief | null;
  incomingInB?: Brief | null;
  checks?: { aSentAsA: boolean; bSentAsB: boolean; aStayedInFront: boolean; replyInAThread: boolean; replyInBThread: boolean; twoThreads: boolean };
  inboxShowsReply?: { a: boolean; b: boolean };
  endSweep?: { revoked: string[]; cancelled: string[] };
  error?: string;
  code?: number;
}
/** A searchDmMessages row; `queue` is on the rows the send queue writes. */
export interface DmRow { _id: string; _creationTime: number; status: string; errorCode?: string; lastError?: string; orgId: string; queue?: { transport?: string; lastAttemptAt?: number } }
export interface Store { version: string; sha256: string }
export type Source = "store" | "jars" | "rig" | "clerk" | "prod rows";
export const FEEDS: Readonly<Record<Source, readonly string[]>> = {
  store: ["prod_store_e2e_pass", "two_accounts_pass"],
  jars: ["prod_store_e2e_pass", "two_accounts_pass"],
  rig: ["prod_store_e2e_pass", "two_accounts_pass"],
  // A Clerk session left open blocks no check; its slice names it for the next run to revoke.
  clerk: [],
  "prod rows": ["prod_send_failures_24h"],
};

export interface DutyData {
  now: number;
  store?: Store;
  accounts?: string;
  /** The accounts the crawler holds or whose exit is on our own servers, so no rig ran. */
  boxed?: string[];
  rig?: RigEvidence;
  rigExit?: number;
  waited?: { ms: number; on: string[] };
  revoked?: number;
  /** `read` counts every searchDmMessages row the CLI returned, `messages` keeps the send queue's rows. */
  rows?: { messages: DmRow[]; read: number; truncated: boolean };
  errors: { source: Source; message: string }[];
}

type Held = { ok: boolean; why: string };
const row = (brief: Brief | null | undefined) => brief ? `row ${brief.id} ${brief.status}${brief.errorCode ? ` ${brief.errorCode}` : ""} from @${brief.sender ?? "?"}` : "no row";
const linkWhy = (link: RigEvidence["linkA"]) => !link ? "the rig stopped before the press" : link.already ? "the account was linked before the press, so the press proved nothing" : `linked ${link.ms} ms after the popup offered it`;

/** The four parts of the headline, each with the evidence that decided it. */
export function parts(rig: RigEvidence | undefined): Record<Part, Held> {
  const paired = rig?.paired;
  return {
    pair: { ok: Boolean(paired?.deviceId) && paired?.status === "connected", why: paired ? `device ${paired.deviceId ?? "none"} ${paired.status ?? "no row"} ${paired.version ?? ""} after ${paired.ms} ms` : "the rig stopped before the pairing" },
    link: { ok: rig?.linkA !== undefined && !rig.linkA.already, why: linkWhy(rig?.linkA) },
    sent: { ok: rig?.checks?.aSentAsA === true, why: row(rig?.sentA) },
    reply: { ok: rig?.checks?.replyInAThread === true && rig.inboxShowsReply?.a === true, why: `${row(rig?.incomingInA)} in thread ${rig?.incomingInA?.thread ?? "none"}, A's DM thread ${rig?.sentA?.thread ?? "none"}, on the Inbox page ${rig?.inboxShowsReply?.a ?? "not read"}` },
  };
}

/** The parts of the second account in the same Chrome. */
export function secondParts(rig: RigEvidence | undefined): Record<SecondPart, Held> {
  return {
    found: { ok: rig?.linkB !== undefined, why: rig?.bNamed ? `the extension named @${rig.bNamed.frontHandle ?? "?"} in front` : "the extension never named B in front" },
    link: { ok: rig?.linkB !== undefined && !rig.linkB.already, why: linkWhy(rig?.linkB) },
    sent: { ok: rig?.checks?.bSentAsB === true, why: row(rig?.sentB) },
    reply: { ok: rig?.checks?.replyInBThread === true && rig.checks.twoThreads && rig.inboxShowsReply?.b === true, why: `${row(rig?.incomingInB)} in thread ${rig?.incomingInB?.thread ?? "none"}, B's DM thread ${rig?.sentB?.thread ?? "none"}, two threads ${rig?.checks?.twoThreads ?? "not read"}, on the Inbox page ${rig?.inboxShowsReply?.b ?? "not read"}` },
    front: { ok: rig?.checks?.aStayedInFront === true, why: `A in front after the sends: ${rig?.checks?.aStayedInFront ?? "not read"}` },
  };
}

const lastTouch = (row: DmRow): number => row.queue?.lastAttemptAt ?? row._creationTime;

/** Every org's extension DMs of the 24 h before `now` that settled failed, delivery_unknown or send_restricted, leaving out rows the queue cancelled. */
export function sendFailures(messages: readonly DmRow[], now: number): DmRow[] {
  return messages.filter(row => row.queue?.transport === "extension" && lastTouch(row) >= now - DAY && row.errorCode !== "cancelled"
    && (row.status === "failed" || row.status === "delivery_unknown" || row.errorCode === "send_restricted"));
}

/** What the unmeasured slice says when a test account has no residential exit: the run waits on the proxy, not on the extension. */
const NO_PROXY = "prod_store_e2e_pass and two_accounts_pass wait on a residential exit for a test account. The extension has nothing to fix, so start no fix job.";
const PROXY_WAIT = "a residential exit for a test account (c229): the crawler holds its jar or puts it on our own servers, so the prod checks are not measured and the extension has nothing to fix.";

/** The rows each metric read (agent factory, 11-26): for each account the DM it sent and the other account's DM read back into its thread,
 *  and the prod searchDmMessages rows read for the failure count, so a met run on n = 0 reads as measuring nothing. */
export function counts(data: DutyData): Record<string, number> {
  const rows = (...briefs: (Brief | null | undefined)[]) => briefs.filter(brief => Boolean(brief?.id)).length;
  return {
    prod_store_e2e_pass: rows(data.rig?.sentA, data.rig?.incomingInA),
    two_accounts_pass: rows(data.rig?.sentB, data.rig?.incomingInB),
    prod_send_failures_24h: data.rows?.read ?? 0,
  };
}

export function report(data: DutyData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput & { n: Record<string, number> } {
  const at = data.now;
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  const unmeasured = new Set<string>();
  for (const error of data.errors) {
    for (const key of FEEDS[error.source]) unmeasured.add(key);
    flagged.push({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 300) });
  }
  if (data.store) flagged.push({ at, kind: "build", excerpt: `the store's CRX ${data.store.version} (sha256 ${data.store.sha256.slice(0, 12)}), loaded under the store id ${STORE_ID}` });
  if (data.accounts) flagged.push({ at, kind: "accounts", excerpt: data.accounts.slice(0, 300) });
  if (data.boxed?.length) {
    unmeasured.add("prod_store_e2e_pass");
    unmeasured.add("two_accounts_pass");
    flagged.push({ at, kind: "exit_down", excerpt: `no residential exit: ${data.boxed.join("; ")}, so the run opened no browser, because owner rule c229 keeps logged-in test accounts off our own server IPs`.slice(0, 300) });
    if (!data.errors.length) flagged.push({ at, kind: OUTSIDE_WAIT, excerpt: PROXY_WAIT });
  }
  if (data.waited) flagged.push({ at, kind: "waited", excerpt: `waited ${Math.round(data.waited.ms / 1000)} s for another run on this box before its own work: ${data.waited.on.join("; ")}`.slice(0, 300) });
  if (data.rig) {
    const first = parts(data.rig);
    const second = secondParts(data.rig);
    metrics.prod_store_e2e_pass = Object.values(first).every(part => part.ok) ? 1 : 0;
    metrics.two_accounts_pass = Object.values(second).every(part => part.ok) ? 1 : 0;
    const stopped = data.rig.error ? ` The rig stopped: ${data.rig.error.replace(/\.$/, "")}.` : "";
    for (const [part, { ok, why }] of Object.entries(first) as [Part, Held][])
      if (!ok) flagged.push({ at, kind: "e2e_part", item: part, excerpt: `${PARTS[part]}: NO.${stopped} ${why}. Evidence: ${OUT}`.slice(0, 300) });
    for (const [part, { ok, why }] of Object.entries(second) as [SecondPart, Held][])
      if (!ok) flagged.push({ at, kind: "second_account_part", item: part, excerpt: `${SECOND_PARTS[part]}: NO.${stopped} ${why}. Evidence: ${OUT}`.slice(0, 300) });
    const sweep = data.rig.endSweep;
    if (!sweep) flagged.push({ at, kind: "cleanup", excerpt: `the rig wrote no end sweep, so its device or unsent DMs in ${ORG} may be left; see ${OUT}/rig.log` });
  }
  if (data.revoked) flagged.push({ at, kind: "cleanup", excerpt: `revoked ${data.revoked} Clerk session(s) of ${EMAIL} that the rig's sign-in opened` });
  if (data.rows) {
    const failures = sendFailures(data.rows.messages, at);
    metrics.prod_send_failures_24h = failures.length;
    if (failures.length) flagged.push({ at, kind: "send_failure", excerpt: `${failures.length} prod extension DMs failed in 24 h: ${failures.map(row => `${row._id} ${row.orgId} ${row.status} ${row.errorCode ?? ""} ${utc(lastTouch(row))}`).join(", ")}`.slice(0, 300) });
    if (data.rows.truncated) flagged.push({ at, kind: "rows_truncated", excerpt: `searchDmMessages returned the ${ROWS_LIMIT} newest rows, the CLI's most; older rows attempted in 24 h are not counted. Read by index instead.` });
  }
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at, data.boxed?.length ? `${data.errors.length ? "Fix the source_error first. " : ""}${NO_PROXY}` : undefined));
  return { metrics, flagged, n: counts(data) };
}

// ---- the store's CRX ----

/** The protobuf fields of `bytes` as [field number, value], for the CRX3 header (length-delimited and varint fields only). */
function protoFields(bytes: Buffer): [number, Buffer | number][] {
  const out: [number, Buffer | number][] = [];
  let at = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  while (at < bytes.length) {
    const tag = varint();
    if ((tag & 7) === 2) {
      const length = varint();
      out.push([Math.floor(tag / 8), bytes.subarray(at, at + length)]);
      at += length;
    } else if ((tag & 7) === 0) out.push([Math.floor(tag / 8), varint()]);
    else throw new Error(`CRX header field ${Math.floor(tag / 8)} has wire type ${tag & 7}`);
  }
  return out;
}

/** Chrome's extension id of a public key: the first 16 bytes of its sha256, each hex digit 0-f written a-p. */
export const extensionIdOf = (publicKey: Buffer): string =>
  [...createHash("sha256").update(publicKey).digest("hex").slice(0, 32)].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join("");

/** A CRX3 file's zip and the public key whose id is `id`. The header's sha256_with_rsa proofs (field 2) each carry a key (field 1);
 *  a store CRX carries the publisher's key and the store's own. */
export function splitCrx(crx: Buffer, id: string): { zip: Buffer; publicKey: Buffer } {
  if (crx.subarray(0, 4).toString() !== "Cr24" || crx.readUInt32LE(4) !== 3) throw new Error(`not a CRX3 file (${crx.subarray(0, 8).toString("hex")})`);
  const headerLength = crx.readUInt32LE(8);
  const keys = protoFields(crx.subarray(12, 12 + headerLength)).filter(([field, value]) => field === 2 && Buffer.isBuffer(value))
    .map(([, proof]) => protoFields(proof as Buffer).find(([field]) => field === 1)?.[1]).filter((key): key is Buffer => Buffer.isBuffer(key));
  const publicKey = keys.find(key => extensionIdOf(key) === id);
  if (!publicKey) throw new Error(`the CRX carries no key of ${id}: ${keys.map(extensionIdOf).join(", ")}`);
  return { zip: crx.subarray(12 + headerLength), publicKey };
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const sh = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { cwd: options.cwd ?? REPO, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) =>
    error ? reject(new Error(`${[file, ...args.slice(0, 3)].join(" ")}: ${error.message.split("\n")[0]} ${String(stderr).trim().slice(-300)}`)) : resolve(stdout));
});

/** The store's current CRX unpacked into `<tmp>/extension` with the store key in its manifest, so Chromium gives it STORE_ID. */
export async function storeBuild(tmp: string): Promise<{ store: Store; dir: string }> {
  const response = await fetch(CRX_URL, { signal: AbortSignal.timeout(SOURCE_DEADLINE_MS) });
  if (!response.ok) throw new Error(`the store answered ${response.status} for the CRX of ${STORE_ID}`);
  const crx = Buffer.from(await response.arrayBuffer());
  const { zip, publicKey } = splitCrx(crx, STORE_ID);
  const zipFile = join(tmp, "store.zip");
  await writeFile(zipFile, zip);
  const dir = join(tmp, "extension");
  await sh("unzip", ["-q", zipFile, "-d", dir]);
  const manifestFile = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { version: string; key?: string };
  await writeFile(manifestFile, JSON.stringify({ ...manifest, key: publicKey.toString("base64") }, null, 2));
  return { store: { version: manifest.version, sha256: createHash("sha256").update(crx).digest("hex") }, dir };
}

// ---- I/O ----

/** The two accounts as the crawler answers them, held in the roles this duty drives them in. `files` is set only when neither is held or boxed. */
export async function jars(tmp: string, read: ReadJar): Promise<{ accounts: string; boxed: string[]; files?: { a: string; b: string } }> {
  const a = await read(ACCOUNT_A, "dm-extension-store-a");
  const b = await read(ACCOUNT_B, "dm-extension-store-b");
  const describe = (role: string, jar: BrowserJar | HeldJar) =>
    "held" in jar ? `${role} @${jar.username}: ${jar.held}` : `${role} @${jar.username} is ${jar.world} on exit ${new URL(jar.proxy_url).host}${jar.valid ? "" : " with a jar the crawler marked invalid"}`;
  const accounts = `${describe("A", a)}; ${describe("B", b)}`;
  const boxed = ([["A", a], ["B", b]] as const).filter(([, jar]) => "held" in jar || boxExit(jar.proxy_url)).map(([role, jar]) => describe(role, jar));
  if ("held" in a || "held" in b || boxed.length) return { accounts, boxed };
  const file = async (jar: BrowserJar) => {
    const path = join(tmp, `jar-${jar.username}.json`);
    await writeFile(path, JSON.stringify(jar), { mode: 0o600 });
    return path;
  };
  return { accounts, boxed, files: { a: await file(a), b: await file(b) } };
}

/** The convex CLI env file for prod, from call.mjs's own table and admin key, in the run's mode 700 folder. */
async function prodEnvFile(dir: string): Promise<string> {
  const call = await import(pathToFileURL(join(REPO, "scripts/repo/convex/call.mjs")).href) as {
    SELF_HOSTED: Record<string, { url: string }>; selfHostedAdminKey: (deployment: string) => string;
  };
  const file = join(dir, "convex-prod.env");
  await writeFile(file, `CONVEX_SELF_HOSTED_URL=${call.SELF_HOSTED[PROD_DEPLOYMENT]!.url}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${call.selfHostedAdminKey(PROD_DEPLOYMENT)}\n`, { mode: 0o600 });
  return file;
}

const convexEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CONVEX_(DEPLOYMENT|SELF_HOSTED|URL)/.test(key)));

async function prodRows(table: string, envFile: string, cwd: string): Promise<unknown[]> {
  const out = await sh(join(REPO, "node_modules/.bin/convex"), ["data", table, "--limit", String(ROWS_LIMIT), "--format", "jsonl", "--env-file", envFile], { cwd, env: convexEnv() });
  return out.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as unknown);
}

const dotenv = async (key: string, file: string) => {
  const value = (await sh(join(REPO, "node_modules/.bin/dotenvx"), ["get", key, "-f", basename(file)], { cwd: join(REPO, dirname(file)) })).trim();
  if (!value) throw new Error(`dotenvx found no ${key} in ${file}`);
  return value;
};

/** Revokes the e2e user's active prod Clerk sessions that began at or after `since`, the ones the rig's sign-in opened. Answers how many. */
async function revokeSessions(since: number): Promise<number> {
  const secret = await dotenv("CLERK_SECRET_KEY", "apps/vent/.env");
  const clerk = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`https://api.clerk.com/v1${path}`, { ...init, headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(SOURCE_DEADLINE_MS) });
    if (!response.ok) throw new Error(`Clerk ${init.method ?? "GET"} ${path.split("?")[0]} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json() as Promise<unknown>;
  };
  const users = await clerk(`/users?email_address=${encodeURIComponent(EMAIL)}`) as { id: string }[];
  if (!users[0]) throw new Error(`prod Clerk has no user ${EMAIL}`);
  const sessions = await clerk(`/sessions?user_id=${users[0].id}&status=active&limit=100`) as { id: string; created_at: number }[];
  const opened = sessions.filter(session => session.created_at >= since);
  for (const session of opened) await clerk(`/sessions/${session.id}/revoke`, { method: "POST" });
  return opened.length;
}

/** Runs one command with its output in `log`, and resolves its exit code. */
const logged = (args: string[], log: string, env: NodeJS.ProcessEnv) => new Promise<number>((resolve, reject) => {
  const out = createWriteStream(log);
  const child = spawn(args[0]!, args.slice(1), { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on("error", reject);
  child.on("close", code => { out.end(); resolve(code ?? 1); });
});

/** The env a clean world's `run` gives a rig, for production: virev.ai, prod Convex through `envFile`, and the virev sign-in through prod
 *  Vent's e2e-prod-reader caller (CLEAN_WORLD_TARGET=production in apps/dm-extension/tests/lib/real-world.mjs). */
async function rigEnv(envFile: string, extensionDir: string): Promise<NodeJS.ProcessEnv> {
  const search = (key: string) => dotenv(key, "apps/search/.env");
  return {
    ...convexEnv(),
    CLEAN_WORLD_REPO: REPO,
    CLEAN_WORLD_SEARCH_URL: "https://virev.ai",
    CLEAN_WORLD_TARGET: "production",
    CLEAN_WORLD_CONVEX_ARGS: JSON.stringify(["--env-file", envFile]),
    CLEAN_WORLD_BROWSER_NO_NETLINK: join(REPO, "scripts/dev/search-clean-world/browser-no-netlink.mjs"),
    E2E_ORG_ID: ORG,
    E2E_USER_EMAIL: EMAIL,
    PUBLIC_CLERK_PUBLISHABLE_KEY: await search("PUBLIC_CLERK_PUBLISHABLE_KEY"),
    VENT_URL: await search("VENT_URL"),
    VENT_KEY: await search("E2E_PROD_READER_VENT_KEY"),
    DM_EXTENSION_DIR: extensionDir,
  };
}

async function measure(now: number): Promise<DutyData> {
  const data: DutyData = { now, errors: [] };
  const step = async <T>(source: Source, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); } catch (error) { data.errors.push({ source, message: message(error) }); return undefined; }
  };
  const tmp = await mkdtemp(join(tmpdir(), "dm-store-prod-"));
  await chmod(tmp, 0o700);
  try {
    const waited = await waitForOtherRuns();
    if (waited.ms >= 1_000) data.waited = waited;
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    const envFile = await prodEnvFile(tmp);
    const built = await step("store", () => storeBuild(tmp));
    if (built) data.store = built.store;
    const jarFiles = await step("jars", async () => jars(tmp, await crawlerJars()));
    if (jarFiles) data.accounts = jarFiles.accounts;
    if (jarFiles?.boxed.length) data.boxed = jarFiles.boxed;
    if (built && jarFiles?.files) {
      const again = await waitForOtherRuns();
      if (again.ms >= 1_000) data.waited = { ms: (data.waited?.ms ?? 0) + again.ms, on: [...new Set([...(data.waited?.on ?? []), ...again.on])] };
      const rigStart = Date.now();
      const env = await step("rig", () => rigEnv(envFile, built.dir));
      if (env) {
        data.rigExit = await logged(["node", join(REPO, "apps/dm-extension/tests/multi-account-real-ig.mjs"), "--a", jarFiles.files.a, "--b", jarFiles.files.b, "--out", OUT], join(OUT, "rig.log"), env);
        const rig = await step("rig", async () => JSON.parse(await readFile(join(OUT, "evidence.json"), "utf8")) as RigEvidence);
        if (rig) data.rig = rig;
        // The rig's Chromium profile holds both accounts' Instagram cookies, so none stays on disk.
        for (const entry of await readdir(OUT).catch(() => [])) if (entry.startsWith("profile-")) await rm(join(OUT, entry), { recursive: true, force: true });
        const revoked = await step("clerk", () => revokeSessions(rigStart));
        if (revoked) data.revoked = revoked;
      }
    }
    const rows = await step("prod rows", async () => {
      const messages = (await prodRows("searchDmMessages", envFile, tmp)) as DmRow[];
      return { messages: messages.filter(row => row.queue), read: messages.length, truncated: messages.length >= ROWS_LIMIT };
    });
    if (rows) data.rows = rows;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return data;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("dm-store-prod: OUTPUT_FILE is not set\n"); process.exit(2); }
  const duty = JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] };
  const result = report(await measure(Date.now()), duty.metrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`dm-store-prod: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
