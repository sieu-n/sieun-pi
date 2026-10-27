import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import type { SdkUpdateState, SdkView } from "./shared/types.ts";

const componentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_SCRIPT = resolve(componentDir, "..", "scripts", "sync-prime-agent.mjs");
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The version in the package.json of package `name` that holds `entry`, the file Node resolved for it: the nearest package.json above the
 * file with that name. Null when none is found. The prime-agent exports map hides `prime-agent/package.json`, so its entry is the way in.
 */
export function packageVersionAbove(entry: string, name: string): string | null {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (typeof value === "object" && value !== null && (value as { name?: unknown }).name === name) {
        const version = (value as { version?: unknown }).version;
        return typeof version === "string" ? version : null;
      }
    } catch { /* no readable package.json here */ }
    if (dirname(directory) === directory) return null;
  }
}

/**
 * The prime-agent package this process loaded, resolved as Node resolves it from this module: the component's own node_modules in a
 * checkout, a parent node_modules in an npm install. Read once: a sync changes node_modules on disk, not the running code.
 */
export function loadedClientVersion(): string {
  try { return packageVersionAbove(fileURLToPath(import.meta.resolve("prime-agent")), "prime-agent") ?? "unknown"; }
  catch { return "unknown"; }
}

/** `shipped`: the prime-agent SDK version the last checked daemon version ships (from 0.10.0 the Rust daemon ships an older TS SDK). */
interface Saved { auto: boolean; failedTarget?: string; failedAt?: string; error?: string; shipped?: { daemon: string; sdk: string } }

function parseSaved(value: unknown): Saved {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return { auto: record.auto !== false,
    ...(typeof record.failedTarget === "string" ? { failedTarget: record.failedTarget } : {}),
    ...(typeof record.failedAt === "string" ? { failedAt: record.failedAt } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(isShipped(record.shipped) ? { shipped: record.shipped } : {}) };
}

function isShipped(value: unknown): value is { daemon: string; sdk: string } {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return typeof record.daemon === "string" && typeof record.sdk === "string";
}

/**
 * Keeps this chat's prime-agent SDK on the version the daemon ships. The daemon names its version in `daemon_hello` on every connect, so a
 * Prime Agent update is seen when the chat reconnects after the daemon restart. With auto on (the default), a new daemon version runs
 * legacy/prime/scripts/sync-prime-agent.mjs once; the script reports the SDK that version ships, which is kept, since a Rust daemon (0.10.0+) ships an
 * older TypeScript SDK. When the script changed packages the service restarts itself (launchd starts it again); on failure the script
 * restores the old packages and Settings shows the error with Retry.
 */
export class SdkSync {
  private daemon: string | null = null;
  private saved: Saved = { auto: true };
  private state: SdkUpdateState = { state: "idle", message: "", log: [] };
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;
  private readonly file: JsonFile<Saved>;

  constructor(path: string, private readonly options: { client: string; build: string | Promise<string>; canRestart: boolean; restart(): void; script?: string }) {
    this.file = { path, label: "SDK update state", parse: parseSaved, initial: () => ({ auto: true }) };
    this.loaded = readJsonFile(this.file).then(saved => { this.saved = saved; }, () => {});
  }

  private async persist(next: Saved): Promise<void> {
    this.saved = next;
    await transactJsonFile(this.file, state => {
      for (const key of Object.keys(state) as (keyof Saved)[]) delete state[key];
      Object.assign(state, next);
    });
  }

  private get script(): string { return this.options.script ?? SYNC_SCRIPT; }
  private get available(): boolean { return existsSync(this.script); }

  /** The SDK version `daemon` ships: the script's answer once it has run for that version, else the daemon version itself. */
  private sdkFor(daemon: string): string { return this.saved.shipped?.daemon === daemon ? this.saved.shipped.sdk : daemon; }
  private needsUpdate(daemon: string): boolean {
    return this.sdkFor(daemon) !== this.options.client && this.saved.auto && this.saved.failedTarget !== daemon && this.available;
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of [...this.listeners]) listener(); }

  async view(): Promise<SdkView> {
    await this.loaded;
    const sdk = this.daemon === null ? null : this.sdkFor(this.daemon);
    const matched = sdk === null || sdk === this.options.client;
    const failed = this.state.state === "idle" && this.saved.failedTarget && this.saved.failedTarget === this.daemon
      ? { state: "failed" as const, target: this.saved.failedTarget, message: this.saved.error ?? "The last update failed.", log: [], ...(this.saved.failedAt ? { at: this.saved.failedAt } : {}) }
      : null;
    return { daemon: this.daemon, sdk, client: this.options.client, build: await this.options.build, matched, auto: this.saved.auto, available: this.available,
      canRestart: this.options.canRestart, update: failed ?? this.state };
  }

  /** Called with `daemon_hello.appVersion` after each daemon connect. */
  async daemonVersion(version: string | undefined): Promise<void> {
    await this.loaded;
    const next = version && VERSION.test(version) ? version : null;
    if (next === this.daemon) return;
    this.daemon = next;
    this.changed();
    if (next && this.needsUpdate(next)) void this.update().catch(() => {});
  }

  async setAuto(auto: boolean): Promise<void> {
    await this.loaded;
    await this.persist({ ...this.saved, auto });
    this.changed();
    if (this.daemon && this.needsUpdate(this.daemon)) void this.update().catch(() => {});
  }

  /** Start matching the SDK to the daemon and return once it runs. A manual start also retries a version that failed before. */
  async start(): Promise<void> {
    await this.loaded;
    if (this.state.state === "running" || this.state.state === "restarting") return;
    if (!this.daemon) throw new Error("The Prime Agent daemon has not reported its version yet.");
    if (!this.available) throw new Error("Updating needs a sieun-pi checkout with legacy/prime/scripts/sync-prime-agent.mjs.");
    void this.update().catch(() => {});
  }

  /** One run at a time. Resolves when the script ends. */
  async update(): Promise<void> {
    await this.loaded;
    if (this.state.state === "running" || this.state.state === "restarting") return;
    const target = this.daemon;
    if (!target || !this.available) return;
    this.state = { state: "running", target, message: `Updating the chat client to prime-agent ${target}.`, log: [], at: new Date().toISOString() };
    this.changed();
    let done: { sdk?: unknown; changed?: unknown } = {};
    const result = await new Promise<{ ok: boolean; message: string }>(resolveRun => {
      const child = spawn(process.execPath, [this.script, "--version", target, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
      let last = "", stderr = "", buffer = "";
      child.stdout.on("data", chunk => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
          try {
            const entry = JSON.parse(line) as { step?: unknown; message?: unknown; sdk?: unknown; changed?: unknown };
            if (entry.step === "done") done = entry;
            if (typeof entry.message === "string") { last = entry.message; this.state = { ...this.state, message: last, log: [...this.state.log, last].slice(-20) }; this.changed(); }
          } catch { /* not a progress line */ }
        }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.once("error", error => resolveRun({ ok: false, message: error.message }));
      child.once("exit", code => resolveRun({ ok: code === 0, message: code === 0 ? last : last || stderr.trim() || `The update script exited ${code}.` }));
    });
    if (!result.ok) {
      await this.persist({ ...this.saved, failedTarget: target, failedAt: new Date().toISOString(), error: result.message.slice(0, 2000) }).catch(() => {});
      this.state = { state: "idle", message: "", log: [] };
      this.changed();
      return;
    }
    const { failedTarget: _target, failedAt: _at, error: _error, ...rest } = this.saved;
    await this.persist({ ...rest, ...(typeof done.sdk === "string" ? { shipped: { daemon: target, sdk: done.sdk } } : {}) }).catch(() => {});
    if (done.changed === false) {
      this.state = { state: "idle", message: result.message, log: [] };
      this.changed();
    } else if (this.options.canRestart) {
      this.state = { ...this.state, state: "restarting", message: `Updated to prime-agent ${target}. The chat restarts now.` };
      this.changed();
      setTimeout(() => this.options.restart(), 500).unref();
    } else {
      this.state = { ...this.state, state: "idle", message: `Updated to prime-agent ${target}. Restart the chat service to load it.` };
      this.changed();
    }
  }
}
