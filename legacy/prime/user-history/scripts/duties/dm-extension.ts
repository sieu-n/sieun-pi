import { execFile, spawn } from "node:child_process";
import { createWriteStream, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { DAY, REPO, settle, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The chrome extension chat's "DM extension working" precheck (`node --import tsx scripts/duties/dm-extension.ts`). No model call. It sends
 * test DMs only between two of the crawler's own Instagram accounts.
 * It answers what the owner checks by hand: a member installs the extension, it pairs and finds the Instagram account by itself, an enqueue
 * from the app goes out, and the reply shows in the same Inbox thread (owner 10-28: "실제 왔다갔다 conversation render되는지 잘 확인해").
 * 1. It builds the store zip and the dev zip from the auto-sns-agent checkout with apps/dm-extension/scripts/package.mjs. The store zip drops
 *    staging.virev.ai from host_permissions, externally_connectable and the page bridge, so it cannot pair with staging; the run then loads
 *    the dev zip of the same tree, which holds the same files with the repo manifest, and a `build` slice says so.
 * 2. It reads the sender's and the replier's saved Instagram sessions from the prod crawler's Postgres on us-metal01 (ig_engage_browser_jars
 *    with ig_engage_accounts and proxy_endpoints, world prod), where the crawler keeps them fresh, into a mode 700 temp folder it deletes.
 * 3. It starts a staging clean world (scripts/dev/search-clean-world.mjs up --target staging --allow-features instagramDm), a fresh
 *    Clerk user and org approved on staging with the instagramDm allow, and runs the two real-Instagram rigs in it as that user and org
 *    (the world's `run` hands them E2E_USER_EMAIL and E2E_ORG_ID) with DM_EXTENSION_DIR set to the unpacked zip:
 *    tests/autopair-real-ig.mjs (pair with no click, account found in the popup and on Connections) and tests/staging-real-ig.mjs (a
 *    test DM from Connections settles sent, the replier answers on Instagram, the reply lands in the store and the Inbox). Evidence and
 *    screenshots go to .cache/duties/dm-extension/latest in auto-sns-agent. `down` deletes the org's staging rows through
 *    search/orgCascade:cascadeDeleteOrg (its devices, Instagram account rows, threads and messages), then the Clerk org and user.
 *    Between the two rigs it reads the sender's daily count in the world's org from Connections' own query, and runs the sending rig
 *    only when SENDS_PER_RUN sends fit under the sender's daily limit; otherwise a sender_daily_limit slice says so and e2e_pass reads
 *    unmeasured instead of a fake 0.
 * 4. It reads staging's searchDmMessages and searchDmDevices for the 24 h counts below, before the world goes down.
 * The headline e2e_pass is 1 only when all four parts hold, each read from the rigs' evidence.json, which they fill from staging rows.
 *
 * Targets in dm-extension.duty.json (the JSON cannot hold comments):
 * - e2e_pass >= 1: the owner's done line for the extension (chrome extension brief, "What done means").
 * - maybe_sent_24h <= 0: an extension row settled delivery_unknown, which nobody retries and a person must check by hand (settle route).
 * - send_restricted_24h <= 0: Instagram refused a send from the extension's account (ig-page.js `send_restricted`).
 * - unknown_username_24h <= 0: a paired Chrome reported an account the server could not register because it had no handle, so Connections
 *   shows it stuck (dmDevices.heartbeat `unregistered`).
 * A source that failed makes the metrics it feeds read missValue() and adds a source_error flag.
 * The duty's timeoutMs of 600 s is its soft target. measured: the first full run on 10-30 took 504 s (04:08:30Z to 04:16:54Z), with the
 * staging row reads about 40 s of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DUTY_FILE = join(HERE, "dm-extension.duty.json");
/** The prod crawler account ids of the two test accounts. 206 sent and 264 replied in the 10-29 staging proof; 202 is signed out since 10-29. */
export const SENDER_ID = 206;
export const REPLIER_ID = 264;
export const WORLD = "dm-ext-duty";
/**
 * The rigs run as the world's own fresh user and org. They ran in Virev Test until 10-30, because observe skipped an Instagram thread
 * another workspace held, so a fresh org never got the reply (dm-first-reading run 3 on 10-30). auto-sns-agent 555db4055 gives each
 * workspace that sent in a shared thread its own copy, so the fresh org gets the reply too.
 * A fresh org also gets a fresh searchSocialAccounts row for the sender, keyed by org and Instagram id (convex/search/dmDevices.ts
 * syncAccounts), so earlier proof runs in other workspaces never use up its daily count. measured: on 10-30 Virev Test's row of 206
 * (@caiyiting8674) read sentToday 8 of dailyLimit 8 and 285 (@gimnayeon1396) 4 of 8 (search/dmDevices:listOutreach), and the queued
 * Inbox reply of that day's proof stayed scheduled.
 */
/** Sends one run makes from the sender in staging-real-ig.mjs: the test DM from Connections, the Inbox DM window send (?outreach=1) and
 *  the Inbox reply. The autopair rig sends none. */
export const SENDS_PER_RUN = 3;
export const STAGING_DEPLOYMENT = "tremendous-eel-825";
export const STAGING_HOST = "https://staging.virev.ai/*";
/** measured: `convex data` on tremendous-eel-825 returned 16,384 and refused 50,001 ("Requested too many items") on 10-30, with 6,066 rows in searchEmailMessages. */
export const ROWS_LIMIT = 16_384;
const OUT = join(REPO, ".cache/duties/dm-extension/latest");
const RIG = /tests\/(autopair|staging)-real-ig\.mjs/;

export type Part = "pair" | "found" | "sent" | "reply";
export const PARTS: Readonly<Record<Part, string>> = {
  pair: "the signed-in /app tab paired the extension with no click",
  found: "the extension found the Instagram account and Connections lists it",
  sent: "a test DM enqueued from Connections settled sent",
  reply: "the replier's answer landed in the same Inbox thread and shows there",
};
export type Source = "build" | "jars" | "world" | "autopair" | "sender" | "e2e" | "staging rows";
export const FEEDS: Readonly<Record<Source, readonly string[]>> = {
  build: ["e2e_pass"], jars: ["e2e_pass"], world: ["e2e_pass"], autopair: ["e2e_pass"], e2e: ["e2e_pass"],
  // A failed read of the sender's count blocks nothing: the sending rig still runs, and the server's own limit refuses past it.
  sender: [],
  "staging rows": ["maybe_sent_24h", "send_restricted_24h", "unknown_username_24h"],
};

export interface Check { name: string; ok: boolean; detail?: unknown }
export interface AutopairEvidence { checks?: Check[] }
export interface E2eEvidence {
  connectionsRow?: string | null;
  firstOutreach?: { id: string; status: string; errorCode?: string; error?: string; threadId?: string } | null;
  bThread?: unknown;
  bReply?: { text: string; onInstagram: boolean };
  replyInStore?: { threadId: string; messageId: string } | null;
  replyInInboxUi?: boolean;
  inboxCard?: { sent?: boolean; error?: string; text?: string };
}
/** A searchDmMessages row; `queue` is on the rows the send queue writes (auto-sns-agent 8d9fea2be2 moved every DM writer there on 10-30). */
export interface DmRow { _id: string; _creationTime: number; status: string; errorCode?: string; lastError?: string; orgId: string; queue?: { transport?: string; lastAttemptAt?: number } }
export interface DeviceRow { _id: string; orgId: string; updatedAt?: number; unregistered?: { platformUserId: string; username: string | null; reason: string }[] }
export interface Build { sha: string; loaded: "store" | "dev"; dirty: string[]; sameFiles: boolean; version: string }
/** The sender's row in the world's org, as Connections reads it: today's sends and the effective daily limit (warm-up and override). */
export interface Sender { username: string; sentToday: number; dailyLimit: number }

export const senderFits = (sender: Sender): boolean => sender.dailyLimit - sender.sentToday >= SENDS_PER_RUN;

export interface DutyData {
  now: number;
  build?: Build;
  autopair?: AutopairEvidence;
  sender?: Sender;
  e2e?: E2eEvidence;
  e2eExit?: number;
  rows?: { messages: DmRow[]; devices: DeviceRow[]; truncated: boolean };
  errors: { source: Source; message: string }[];
}

const check = (evidence: AutopairEvidence | undefined, prefix: string): Check | undefined => evidence?.checks?.find(c => c.name.startsWith(prefix));

/** Each of the four parts, held or not, with the evidence that decided it. */
export function parts(autopair: AutopairEvidence | undefined, e2e: E2eEvidence | undefined): Record<Part, { ok: boolean; why: string }> {
  const pair = check(autopair, "2 ");
  const popup = check(autopair, "3a ");
  const listed = check(autopair, "3b ");
  const first = e2e?.firstOutreach;
  const reply = e2e?.replyInStore;
  const sameThread = Boolean(reply?.threadId && first?.threadId && reply.threadId === first.threadId);
  return {
    pair: { ok: pair?.ok === true, why: pair ? `autopair "${pair.name}": ${JSON.stringify(pair.detail ?? null)}` : "autopair wrote no pair check" },
    found: {
      ok: popup?.ok === true && listed?.ok === true && Boolean(e2e?.connectionsRow),
      why: `autopair popup ${popup?.ok ?? "no check"}, Connections ${listed?.ok ?? "no check"}; e2e Connections row ${e2e?.connectionsRow ?? "none"}`,
    },
    sent: { ok: first?.status === "sent", why: first ? `row ${first.id} ${first.status}${first.errorCode ? ` ${first.errorCode}` : ""}${first.error ? `: ${first.error}` : ""}` : "no outbound row for the test DM" },
    reply: {
      ok: sameThread && e2e?.replyInInboxUi === true,
      why: !e2e?.bReply ? "the replier never answered on Instagram (the rig stopped earlier)"
        : !reply ? `reply "${e2e.bReply.text}" never reached the store`
        : `reply thread ${reply.threadId}, test DM thread ${first?.threadId ?? "none"}, shown in the Inbox ${e2e.replyInInboxUi === true}`,
    },
  };
}

const lastTouch = (row: DmRow): number => row.queue?.lastAttemptAt ?? row._creationTime;

/** The extension's settle and register errors of the 24 h before `now`. */
export function errorCounts(rows: { messages: DmRow[]; devices: DeviceRow[] }, now: number) {
  const recent = rows.messages.filter(row => row.queue?.transport === "extension" && lastTouch(row) >= now - DAY);
  const maybeSent = recent.filter(row => row.status === "delivery_unknown");
  const restricted = recent.filter(row => row.errorCode === "send_restricted");
  const unknown = rows.devices.filter(device => (device.updatedAt ?? 0) >= now - DAY)
    .flatMap(device => (device.unregistered ?? []).filter(entry => entry.reason === "unknown_username").map(entry => ({ device: device._id, org: device.orgId, ...entry })));
  return { maybeSent, restricted, unknown };
}

export function report(data: DutyData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const at = data.now;
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  const unmeasured = new Set<string>();
  for (const error of data.errors) {
    for (const key of FEEDS[error.source]) unmeasured.add(key);
    flagged.push({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 300) });
  }
  if (data.build) {
    const { sha, loaded, dirty, sameFiles, version } = data.build;
    flagged.push({ at, kind: "build", excerpt: `${version} from auto-sns-agent ${sha.slice(0, 10)}: ${loaded === "dev" ? "the store zip lists no staging host, so the run loaded the dev zip of the same tree" : "the run loaded the store zip"}${sameFiles ? ", same files in both zips" : "; the store and dev zips hold DIFFERENT files"}${dirty.length ? `; uncommitted in apps/dm-extension: ${dirty.join(", ")}` : ""}`.slice(0, 300) });
  }
  const blocked = data.sender !== undefined && !senderFits(data.sender);
  if (data.sender && blocked) {
    const { username, sentToday, dailyLimit } = data.sender;
    unmeasured.add("e2e_pass");
    flagged.push({ at, kind: "sender_daily_limit", excerpt: `sender ${SENDER_ID} @${username} had sent ${sentToday} of its daily limit of ${dailyLimit} in the world's org, and a run sends ${SENDS_PER_RUN}, so the sending rig did not run and the e2e parts are not measured` });
  }
  if (!blocked && (data.autopair || data.e2e)) {
    const held = parts(data.autopair, data.e2e);
    metrics.e2e_pass = Object.values(held).every(part => part.ok) ? 1 : 0;
    for (const [part, { ok, why }] of Object.entries(held) as [Part, { ok: boolean; why: string }][])
      if (!ok) flagged.push({ at, kind: "e2e_part", item: part, excerpt: `${PARTS[part]}: NO. ${why}. Evidence: ${OUT}`.slice(0, 300) });
    const failedChecks = (data.autopair?.checks ?? []).filter(c => !c.ok && !/^[23][ab]? /.test(c.name)).map(c => c.name);
    if (failedChecks.length) flagged.push({ at, kind: "autopair_check", excerpt: `other autopair checks that failed: ${failedChecks.join("; ")}`.slice(0, 300) });
    const card = data.e2e?.inboxCard;
    if (card && card.sent === false) flagged.push({ at, kind: "inbox_card", excerpt: `the Inbox DM window (?outreach=1) did not send (not one of the four parts): ${card.error ?? card.text ?? ""}`.slice(0, 300) });
    if (data.e2eExit && metrics.e2e_pass === 1) flagged.push({ at, kind: "e2e_tail", excerpt: `staging-real-ig.mjs exited ${data.e2eExit} after the four parts held: the Inbox reply step after them failed; see ${OUT}/e2e.log`.slice(0, 300) });
  }
  if (data.rows) {
    const { maybeSent, restricted, unknown } = errorCounts(data.rows, at);
    metrics.maybe_sent_24h = maybeSent.length;
    metrics.send_restricted_24h = restricted.length;
    metrics.unknown_username_24h = unknown.length;
    const rowList = (rows: DmRow[]) => rows.map(row => `${row._id} ${row.orgId} ${row.errorCode ?? ""} ${utc(lastTouch(row))}`).join(", ");
    if (maybeSent.length) flagged.push({ at, kind: "maybe_sent", excerpt: `${maybeSent.length} staging extension DMs settled delivery_unknown in 24 h: ${rowList(maybeSent)}`.slice(0, 300) });
    if (restricted.length) flagged.push({ at, kind: "send_restricted", excerpt: `${restricted.length} staging extension DMs hit send_restricted in 24 h: ${rowList(restricted)}`.slice(0, 300) });
    if (unknown.length) flagged.push({ at, kind: "unknown_username", excerpt: `${unknown.length} accounts a paired Chrome reported in 24 h are unregistered for unknown_username: ${unknown.map(entry => `${entry.platformUserId} on device ${entry.device} (${entry.org})`).join(", ")}`.slice(0, 300) });
    if (data.rows.truncated) flagged.push({ at, kind: "rows_truncated", excerpt: `searchDmMessages returned the ${ROWS_LIMIT} newest rows, the CLI's most; older rows attempted in 24 h are not counted. Read by index instead.` });
  }
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics, flagged };
}

// ---- I/O ----

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const sh = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) => new Promise<string>((resolve, reject) => {
  const child = execFile(file, args, { cwd: options.cwd ?? REPO, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) =>
    error ? reject(new Error(`${[file, ...args.slice(0, 3)].join(" ")}: ${error.message.split("\n")[0]} ${String(stderr).trim().slice(-300)}`)) : resolve(stdout));
  if (options.input !== undefined) child.stdin?.end(options.input);
});

/** Runs one command with its output in `log`, and resolves its exit code. */
const logged = (args: string[], log: string, env: NodeJS.ProcessEnv) => new Promise<number>((resolve, reject) => {
  const out = createWriteStream(log);
  const child = spawn(args[0]!, args.slice(1), { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on("error", reject);
  child.on("close", code => { out.end(); resolve(code ?? 1); });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The two zips from the checkout, and the folder of the one that can pair with staging, unpacked. */
export async function build(tmp: string): Promise<{ build: Build; dir: string }> {
  const zipAt = async (dev: boolean) => {
    const out = join(tmp, dev ? "dev.zip" : "store.zip");
    const files = (await sh("node", ["apps/dm-extension/scripts/package.mjs", ...(dev ? ["--dev"] : []), "--out", out])).split("\n").slice(1).map(line => line.trim()).filter(Boolean);
    return { out, files };
  };
  const [store, dev] = [await zipAt(false), await zipAt(true)];
  const manifest = JSON.parse(await sh("unzip", ["-p", store.out, "manifest.json"])) as { version: string; host_permissions?: string[] };
  const loaded = manifest.host_permissions?.includes(STAGING_HOST) ? "store" : "dev";
  const dir = join(tmp, "extension");
  await sh("unzip", ["-q", loaded === "store" ? store.out : dev.out, "-d", dir]);
  const sha = (await sh("git", ["rev-parse", "HEAD"])).trim();
  const dirty = (await sh("git", ["status", "--porcelain", "--", "apps/dm-extension"])).split("\n").filter(Boolean).map(line => line.slice(3));
  return { build: { sha, loaded, dirty, sameFiles: store.files.join() === dev.files.join(), version: manifest.version }, dir };
}

export interface JarRow { id: number; username: string; ig_user_id: string | null; cookies: { name: string; value: string }[] | null; status: string; valid: boolean; jar_at: string }

/** The Instagram id a jar is signed in as. ig_engage_accounts.ig_user_id is null for 206 on 10-31, so the session's
 *  ds_user_id cookie names it, as the rigs read it (apps/dm-extension/tests/lib/real-world.mjs). */
export function jarIgUserId(row: JarRow): string {
  const id = row.ig_user_id ?? row.cookies?.find(cookie => cookie.name === "ds_user_id")?.value;
  if (!id) throw new Error(`account ${row.id} @${row.username} has no ig_user_id and its jar no ds_user_id cookie`);
  return String(id);
}

/** The two accounts' saved sessions from the prod crawler's Postgres, as the rigs' jar files (mode 600). Prints no cookie. */
export async function jars(tmp: string): Promise<{ sender: string; senderIgId: string; replier: string; notes: string[] }> {
  const sql = `begin read only;
select json_build_object('id', a.id, 'username', a.username, 'ig_user_id', a.ig_user_id, 'cookies', j.cookies::json, 'user_agent', j.user_agent,
  'proxy_url', e.proxy_url, 'status', a.status, 'valid', j.valid, 'jar_at', j.updated_at)::text
from ig_engage_accounts a join ig_engage_browser_jars j on j.account_id = a.id join proxy_endpoints e on e.id = a.proxy_endpoint_id
where a.world = 'prod' and a.id in (${SENDER_ID}, ${REPLIER_ID});
commit;`;
  const out = await sh("ssh", ["-o", "BatchMode=yes", "us-metal01", "docker exec -i virev-prod-postgres psql -U crawler -d crawler_v3 -At -v ON_ERROR_STOP=1"], { input: sql });
  const rows = out.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as JarRow);
  const notes: string[] = [];
  const files: Record<number, string> = {};
  for (const row of rows) {
    files[row.id] = join(tmp, `jar-${row.id}.json`);
    await writeFile(files[row.id]!, JSON.stringify(row), { mode: 0o600 });
    if (row.status !== "active" || !row.valid) notes.push(`${row.id} @${row.username} is ${row.status}, jar ${row.valid ? "valid" : "invalid"} (saved ${row.jar_at})`);
  }
  for (const id of [SENDER_ID, REPLIER_ID]) if (!files[id]) throw new Error(`the prod crawler has no saved session for account ${id}`);
  return { sender: files[SENDER_ID]!, senderIgId: jarIgUserId(rows.find(row => row.id === SENDER_ID)!), replier: files[REPLIER_ID]!, notes };
}

/** The sender's row in the world's org from Connections' own read (search/dmDevices:listOutreach), as an admin of that org. */
async function senderCount(igUserId: string): Promise<Sender> {
  const env = await sh("node", ["scripts/dev/search-clean-world.mjs", "env", "--name", WORLD]);
  const org = /^export E2E_ORG_ID="(.+)"$/m.exec(env)?.[1];
  if (!org) throw new Error(`search-clean-world env --name ${WORLD} names no E2E_ORG_ID`);
  const identity = JSON.stringify({ tokenIdentifier: `dm-extension-duty|${org}`, subject: "dm-extension-duty", orgId: org, orgRole: "org:admin" });
  const out = JSON.parse(await sh("node", ["scripts/repo/convex/call.mjs", STAGING_DEPLOYMENT, "query", "search/dmDevices:listOutreach", "{}", identity])) as
    { value: { accounts: { platformUserId: string | null; username: string; sentToday: number; dailyLimit: number }[] } };
  const row = out.value.accounts.find(account => account.platformUserId === igUserId);
  if (!row) throw new Error(`Connections of the world's org ${org} lists no account ${igUserId} after autopair`);
  return { username: row.username, sentToday: row.sentToday, dailyLimit: row.dailyLimit };
}

/** Waits while another real-Instagram rig runs on this box, so two browsers never drive one account at once. */
async function waitForOtherRigs(): Promise<void> {
  for (;;) {
    const running = await sh("pgrep", ["-af", "node"]).catch(() => "");
    if (!running.split("\n").some(line => RIG.test(line))) return;
    // measured: one rig run took 56 s (autopair) to 278 s (staging-real-ig) on 10-30, so a look every 30 s adds little to the wait.
    await sleep(30_000);
  }
}

async function staging(table: string, limit: number, cwd: string): Promise<unknown[]> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CONVEX_(DEPLOYMENT|SELF_HOSTED|URL)/.test(key)));
  const out = await sh(join(REPO, "node_modules/.bin/convex"), ["data", table, "--limit", String(limit), "--format", "jsonl", "--deployment-name", STAGING_DEPLOYMENT], { cwd, env });
  return out.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as unknown);
}

async function measure(now: number): Promise<DutyData> {
  const data: DutyData = { now, errors: [] };
  const step = async <T>(source: Source, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); } catch (error) { data.errors.push({ source, message: message(error) }); return undefined; }
  };
  const tmp = await mkdtemp(join(tmpdir(), "dm-extension-duty-"));
  await chmod(tmp, 0o700);
  const world = ["node", "scripts/dev/search-clean-world.mjs"];
  let up = false;
  try {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    const built = await step("build", () => build(tmp));
    if (built) data.build = built.build;
    const jarFiles = await step("jars", () => jars(tmp));
    if (jarFiles?.notes.length) data.errors.push({ source: "jars", message: jarFiles.notes.join("; ") });
    if (built && jarFiles) {
      await waitForOtherRigs();
      await logged([...world, "down", "--name", WORLD], join(OUT, "world-down-before.log"), process.env);
      const upCode = await logged([...world, "up", "--target", "staging", "--name", WORLD, "--allow-features", "instagramDm", "--owner-pid", String(process.pid)], join(OUT, "world-up.log"), process.env);
      up = upCode === 0;
      if (!up) data.errors.push({ source: "world", message: `search-clean-world up --target staging exited ${upCode}; see ${OUT}/world-up.log` });
      else {
        const env = { ...process.env, DM_EXTENSION_DIR: built.dir };
        // `run` starts its command in apps/search, so the rig path is absolute.
        const run = (rig: string, args: string[], name: string) => logged([...world, "run", "--name", WORLD, "--", "node", join(REPO, "apps/dm-extension/tests", rig), ...args, "--out", join(OUT, name)], join(OUT, `${name}.log`), env);
        await run("autopair-real-ig.mjs", ["--a", jarFiles.sender], "autopair");
        const autopair = await step("autopair", async () => JSON.parse(await readFile(join(OUT, "autopair/evidence.json"), "utf8")) as AutopairEvidence);
        if (autopair) data.autopair = autopair;
        const sender = await step("sender", () => senderCount(jarFiles.senderIgId));
        if (sender) data.sender = sender;
        if (!sender || senderFits(sender)) {
          data.e2eExit = await run("staging-real-ig.mjs", ["--a", jarFiles.sender, "--b", jarFiles.replier], "e2e");
          const e2e = await step("e2e", async () => JSON.parse(await readFile(join(OUT, "e2e/evidence.json"), "utf8")) as E2eEvidence);
          if (e2e) data.e2e = e2e;
        }
        // The rigs' Chromium profiles hold the accounts' Instagram cookies, so none stays on disk.
        for (const name of ["autopair", "e2e"]) for (const entry of await readdir(join(OUT, name)).catch(() => [])) if (entry.startsWith("profile-")) await rm(join(OUT, name, entry), { recursive: true, force: true });
      }
    }
    const rows = await step("staging rows", async () => {
      const messages = (await staging("searchDmMessages", ROWS_LIMIT, tmp)) as DmRow[];
      const devices = (await staging("searchDmDevices", ROWS_LIMIT, tmp)) as DeviceRow[];
      return { messages: messages.filter(row => row.queue), devices, truncated: messages.length >= ROWS_LIMIT };
    });
    if (rows) data.rows = rows;
  } finally {
    if (up) await logged([...world, "down", "--name", WORLD], join(OUT, "world-down.log"), process.env).catch(() => 1);
    await rm(tmp, { recursive: true, force: true });
  }
  return data;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("dm-extension: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const result = report(await measure(Date.now()), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`dm-extension: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
