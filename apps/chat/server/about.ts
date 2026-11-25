/**
 * GET /api/about: which versions each agent box runs, read through the box's agent relay `check` op, so pi-host needs no new op. The last good
 * read of each box stays in `<data dir>/about.json`, so an away box shows its last values across a server restart, and the newest Pi on npm
 * is read at most once an hour.
 */
import { join } from "node:path";
import type { AboutHost, AboutReport, BoxVersions, ReleaseView } from "../web/src/lib/api/types.ts";
import { runCheck } from "../../../legacy/prime/user-history/src/wakes.ts";
import { FixtureHost } from "./host/fixture.ts";
import { MultiHost } from "./host/multi-host.ts";
import type { Host } from "./host/types.ts";
import { readJson, writeJson } from "./store.ts";

export const ABOUT_FILE = "about.json";
const NPM_LATEST = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest";
/** The owner's ask (#sw-factory-build p244): npm is read at most once an hour. */
const NPM_EVERY_MS = 3_600_000;
/** The relay's `check` op needs a positive timeout; the read took under 1 s on us-metal02 and the Mac on 11-25. */
const READ_MS = 30_000;

/**
 * Prints one line per value, `key<TAB>payload`, with plain sh tools only, because the Mac's relay runs under launchd with no node on PATH. The
 * relay returns the last 1,500 characters of output; this printed 653 on us-metal02 and 583 on the Mac on 11-25.
 */
export const VERSIONS_COMMAND = `{ P=$HOME/.local/share/pi-host/current; A=$HOME/.local/share/sieun-pi-apps-chat/current
printf 'piHost\\t%s\\t' "$(readlink "$P")"; tr -d '\\n' < "$P/release.json"; echo
printf 'appsChat\\t%s\\t' "$(readlink "$A")"; tr -d '\\n' < "$A/release.json"; echo
printf 'pi\\t'; grep -m1 '"version"' "$P/packages/node_modules/@earendil-works/pi-coding-agent/package.json" | tr -d '\\n'; echo
printf 'vendored\\t'; sed -n 3,4p "$P/packages/pi-host/src/durable/vendor/prime-harness.ts" | tr -d '\\n'; echo
printf 'prime\\t'; "$HOME/.local/share/prime-agent/bin/prime-agent" status --json | grep -E '"(version|isDefault)"' | tr -d ' \\n'; echo
} 2>/dev/null; exit 0`;

/** A box the About page reads: whether its link is up, and how to run a shell command there. */
export interface AboutBox { box: string; up: boolean; check: (command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }> }

interface Saved {
  boxes: Record<string, { readAt: number; versions: BoxVersions }>;
  piLatest: { version: string; checkedAt: number } | null;
}

function releaseOf(payload: string | undefined): ReleaseView | null {
  const [name = "", json = ""] = (payload ?? "").split("\t");
  const release = name.trim().split("/").pop() ?? "";
  if (!release) return null;
  let built: { sha?: unknown; builtAt?: unknown } = {};
  try { built = JSON.parse(json) as typeof built; } catch { /* a folder without release.json keeps the sha in its name */ }
  return {
    release,
    sha: typeof built.sha === "string" ? built.sha : release.replace(/^release-/, ""),
    builtAt: typeof built.builtAt === "string" ? built.builtAt : null,
  };
}

/** The values VERSIONS_COMMAND printed; throws when its output has no piHost line, so the command did not run. */
export function parseVersions(output: string): BoxVersions {
  const lines = new Map(output.split("\n").flatMap(line => {
    const tab = line.indexOf("\t");
    return tab > 0 ? [[line.slice(0, tab), line.slice(tab + 1)] as const] : [];
  }));
  if (!lines.has("piHost")) throw new Error(`the version read printed no piHost line: ${output.trim().slice(0, 300) || "(no output)"}`);
  const vendored = /at ([0-9a-f]{40})\W*\(([^)\s]+)\)/.exec(lines.get("vendored") ?? "");
  const daemons = [...(lines.get("prime") ?? "").matchAll(/"version":"([^"]+)","isDefault":(true|false)/g)];
  const daemon = daemons.find(m => m[2] === "true") ?? daemons[0];
  return {
    pi: /"version":\s*"([^"]+)"/.exec(lines.get("pi") ?? "")?.[1] ?? null,
    piHost: releaseOf(lines.get("piHost")),
    appsChat: releaseOf(lines.get("appsChat")),
    primeVendored: vendored ? { version: vendored[2]!, sha: vendored[1]! } : null,
    primeDaemon: daemon?.[1] ?? null,
  };
}

/** The newest @earendil-works/pi-coding-agent on npm. */
export async function npmLatest(): Promise<string> {
  const answer = await fetch(NPM_LATEST);
  if (!answer.ok) throw new Error(`npm answered ${answer.status}`);
  const { version } = (await answer.json()) as { version?: unknown };
  if (typeof version !== "string") throw new Error("npm's latest has no version");
  return version;
}

export class About {
  private readonly saved: Saved;
  private npmTriedAt = -Infinity;
  private npm?: Promise<void>;

  constructor(private readonly file: string, private readonly fetchLatest: () => Promise<string> = npmLatest, private readonly now: () => number = Date.now) {
    const saved = readJson<Partial<Saved>>(file, {});
    this.saved = { boxes: saved.boxes ?? {}, piLatest: saved.piLatest ?? null };
  }

  async report(boxes: AboutBox[]): Promise<AboutReport> {
    const [hosts] = await Promise.all([Promise.all(boxes.map(box => this.read(box))), this.latest()]);
    return { checkedAt: this.now(), piLatest: this.saved.piLatest, hosts };
  }

  private async read(box: AboutBox): Promise<AboutHost> {
    let error: string | null = null;
    if (box.up) {
      try {
        const versions = parseVersions((await box.check(VERSIONS_COMMAND, READ_MS)).output);
        this.saved.boxes[box.box] = { readAt: this.now(), versions };
        writeJson(this.file, this.saved);
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
    }
    const last = this.saved.boxes[box.box];
    return { box: box.box, state: box.up ? "up" : "away", readAt: last?.readAt ?? null, versions: last?.versions ?? null, error };
  }

  /** Reads npm when the last try is an hour old; a failed try keeps the last version and waits the hour too. */
  private latest(): Promise<void> {
    if (this.npm) return this.npm;
    if (this.now() - Math.max(this.npmTriedAt, this.saved.piLatest?.checkedAt ?? -Infinity) < NPM_EVERY_MS) return Promise.resolve();
    this.npmTriedAt = this.now();
    this.npm = this.fetchLatest()
      .then(version => {
        this.saved.piLatest = { version, checkedAt: this.now() };
        writeJson(this.file, this.saved);
      })
      .catch(() => {})
      .finally(() => { this.npm = undefined; });
    return this.npm;
  }
}

/** Each box GET /api/about reads, the chat's own first: a relay box through its relay, and a box without one on this machine. */
export function aboutBoxes(host: Host, self: string): AboutBox[] {
  if (host instanceof FixtureHost) return host.aboutBoxes();
  if (!(host instanceof MultiHost)) return [{ box: self, up: true, check: runCheck }];
  return host.list().map(({ box }): AboutBox => {
    const relay = host.relay(box);
    return relay ? { box, up: relay.state().state === "up", check: (command, timeoutMs) => relay.check(command, timeoutMs) } : { box, up: true, check: runCheck };
  });
}

const abouts = new WeakMap<Host, About>();

export function aboutReport(host: Host, self: string, dataDir: string): Promise<AboutReport> {
  let about = abouts.get(host);
  if (!about) abouts.set(host, about = new About(join(dataDir, ABOUT_FILE), host instanceof FixtureHost ? host.piLatest : npmLatest));
  return about.report(aboutBoxes(host, self));
}
