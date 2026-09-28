import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import type { RemoteAccessInput, RemoteAccessView, RemoteMode } from "./shared/types.ts";

/** What the HTTP server needs from phone access: the origin to accept now, the Settings view, and the switches. */
export type RemoteControl = {
  origin(): string | null;
  view(editable: boolean): RemoteAccessView;
  set(input: RemoteAccessInput): Promise<void>;
  check(): Promise<void>;
};

export type CommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

export const runCommand: Runner = (file, args, timeoutMs) => new Promise(resolve => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
    resolve({ code: failure ? typeof failure.code === "number" ? failure.code : 1 : 0, stdout: String(stdout), stderr: String(stderr || failure?.message || ""),
      timedOut: failure?.killed === true });
  });
});

const TAILSCALE_PATHS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale"];

/** launchd starts jobs with a minimal PATH, so the CLI is looked up at its install locations. */
export async function findTailscale(): Promise<string | null> {
  const override = process.env.SIEUN_PI_TAILSCALE;
  for (const path of override ? [override] : TAILSCALE_PATHS) {
    try { await access(path, constants.X_OK); return path; } catch { /* next */ }
  }
  return null;
}

export type RemoteSnapshot = {
  mode: RemoteMode; state: "on" | "off" | "checking" | "problem"; message: string; origin: string | null;
  checkedAt: string | null; reachable: boolean | null;
};
type Options = {
  port: number; capability: string; mode: RemoteMode; origin: string | null;
  /** Persists the mode and the origin the Host check accepts. */
  save(value: { mode: RemoteMode; origin: string | null }): Promise<void>;
  /** Resolves when this instance answers its identity route; the end-to-end check waits for it. */
  identity(): Promise<{ instanceId: string }>;
  run?: Runner; tailscale?: () => Promise<string | null>; fetch?: typeof fetch; now?: () => Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const firstLine = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 400);

/**
 * Keeps `https://<this Mac's tailnet name>/` proxied to the loopback listener through Tailscale Serve.
 * It adds the root handler on port 443 when it is missing, never replaces a handler that points elsewhere,
 * and proves the result by requesting this instance's identity through the tailnet URL.
 */
export class RemoteAccess {
  private mode: RemoteMode;
  private origin: string | null;
  private snapshot: RemoteSnapshot;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<RemoteSnapshot> | null = null;
  private readonly run: Runner;
  private readonly target: string;

  constructor(private readonly options: Options) {
    this.mode = options.mode;
    this.origin = options.origin;
    this.run = options.run ?? runCommand;
    this.target = `http://127.0.0.1:${options.port}`;
    this.snapshot = this.mode === "off" ? this.off() : { mode: this.mode, state: "checking", message: "Checking phone access.", origin: this.origin, checkedAt: null, reachable: null };
  }

  /** The HTTPS origin the Host and Origin checks accept besides loopback. */
  allowedOrigin(): string | null { return this.mode === "off" ? null : this.origin; }
  status(): RemoteSnapshot { return this.snapshot; }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async setMode(mode: "tailscale" | "off"): Promise<RemoteSnapshot> {
    await this.pending?.catch(() => {});
    if (mode === "off" && this.mode === "tailscale") await this.removeHandler();
    this.mode = mode;
    if (mode === "off") this.origin = null;
    await this.options.save({ mode: this.mode, origin: this.origin });
    return this.check();
  }

  check(): Promise<RemoteSnapshot> {
    this.pending ??= this.evaluate().then(snapshot => { this.snapshot = snapshot; return snapshot; })
      .catch(error => (this.snapshot = this.problem(error instanceof Error ? error.message : String(error))))
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  private off(): RemoteSnapshot {
    return { mode: "off", state: "off", message: "Off. Only this Mac can open the chat.", origin: null, checkedAt: this.stamp(), reachable: null };
  }
  private problem(message: string, reachable: boolean | null = null): RemoteSnapshot {
    return { mode: this.mode, state: "problem", message, origin: this.allowedOrigin(), checkedAt: this.stamp(), reachable };
  }
  private stamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  private async evaluate(): Promise<RemoteSnapshot> {
    if (this.mode === "off") return this.off();
    if (this.mode === "custom") {
      const reachable = await this.probe();
      return { mode: "custom", state: reachable ? "on" : "problem", origin: this.origin, checkedAt: this.stamp(), reachable,
        message: reachable ? `On through ${this.origin}, set with --public-origin.` : `Set to ${this.origin} with --public-origin, but that address did not answer the chat check from this Mac.` };
    }
    const cli = await (this.options.tailscale ?? findTailscale)();
    if (!cli) return this.problem("Tailscale is not installed on this Mac. Install it from tailscale.com and sign in.");
    const status = await this.json(cli, ["status", "--json"]);
    const backend = isRecord(status) && typeof status.BackendState === "string" ? status.BackendState : "unknown";
    if (backend !== "Running") return this.problem(`Tailscale is ${backend === "unknown" ? "not answering" : backend} on this Mac. Open Tailscale and connect.`);
    const self = isRecord(status) && isRecord(status.Self) ? status.Self : {};
    const dnsName = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
    const certDomains = isRecord(status) && Array.isArray(status.CertDomains) ? status.CertDomains.map(String) : [];
    if (!dnsName || !certDomains.map(domain => domain.toLowerCase()).includes(dnsName)) {
      return this.problem("This tailnet has no HTTPS certificate for this Mac. Turn on MagicDNS and HTTPS Certificates on the DNS page of the Tailscale admin console.");
    }
    const origin = `https://${dnsName}`;
    const conflict = await this.ensureHandler(cli, dnsName);
    if (conflict) return this.problem(conflict);
    if (origin !== this.origin) { this.origin = origin; await this.options.save({ mode: this.mode, origin }); }
    const reachable = await this.probe();
    if (!reachable) return this.problem(`Tailscale Serve is set, but ${dnsName} did not answer the chat check from this Mac. It retries every minute.`, false);
    return { mode: "tailscale", state: "on", message: `On. Devices signed in to your tailnet can open the chat at ${dnsName}.`, origin, checkedAt: this.stamp(), reachable: true };
  }

  private async json(cli: string, args: string[]): Promise<unknown> {
    const result = await this.run(cli, args, 10_000);
    if (result.code !== 0) throw new Error(`tailscale ${args.join(" ")} failed: ${firstLine(result.stderr || result.stdout) || "exit " + result.code}`);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`tailscale ${args.join(" ")} returned output that is not JSON.`); }
  }

  /** What `tailscale serve` sends `https://<dnsName>/` to: null when unset, "ours", or a description of the other target. */
  private async rootHandler(cli: string, dnsName: string): Promise<string | null> {
    const serve = await this.json(cli, ["serve", "status", "--json"]);
    if (!isRecord(serve)) return null;
    const tcp = isRecord(serve.TCP) && isRecord(serve.TCP["443"]) ? serve.TCP["443"] : null;
    if (tcp && tcp.HTTPS !== true) return "a TCP forwarder";
    const web = isRecord(serve.Web) ? serve.Web : {};
    const key = Object.keys(web).find(name => name.toLowerCase() === `${dnsName}:443`);
    const handlers = key && isRecord(web[key]) && isRecord((web[key] as Record<string, unknown>).Handlers) ? (web[key] as { Handlers: Record<string, unknown> }).Handlers : {};
    const root = handlers["/"];
    if (!isRecord(root)) return null;
    const proxy = typeof root.Proxy === "string" ? root.Proxy.replace(/\/+$/, "") : null;
    if (proxy && [this.target, `http://localhost:${this.options.port}`].includes(proxy)) return "ours";
    return proxy ?? (typeof root.Path === "string" ? "a folder" : "text");
  }

  private async ensureHandler(cli: string, dnsName: string): Promise<string | null> {
    const current = await this.rootHandler(cli, dnsName);
    if (current === "ours") return null;
    if (current !== null) return `Tailscale Serve already sends https://${dnsName}/ to ${current}. Run "tailscale serve --https=443 --set-path=/ off" on this Mac to free it.`;
    const result = await this.run(cli, ["serve", "--bg", "--https=443", this.target], 20_000);
    if (result.code !== 0 || result.timedOut) {
      const detail = firstLine(result.stdout + "\n" + result.stderr);
      return `tailscale serve could not add https://${dnsName}/${result.timedOut ? " within 20 s" : ""}. ${detail}`.trim();
    }
    return (await this.rootHandler(cli, dnsName)) === "ours" ? null : `tailscale serve reported success, but https://${dnsName}/ does not point at ${this.target}.`;
  }

  private async removeHandler(): Promise<void> {
    const cli = await (this.options.tailscale ?? findTailscale)();
    if (!cli || !this.origin) return;
    const dnsName = new URL(this.origin).hostname;
    if ((await this.rootHandler(cli, dnsName).catch(() => null)) !== "ours") return;
    const result = await this.run(cli, ["serve", "--https=443", "--set-path=/", "off"], 15_000);
    if (result.code !== 0) throw new Error(`tailscale serve could not remove https://${dnsName}/: ${firstLine(result.stderr || result.stdout)}`);
  }

  /** The capability the phone needs, not only the transport: this instance must answer through the remote origin. */
  private async probe(): Promise<boolean> {
    if (!this.origin) return false;
    try {
      const { instanceId } = await this.options.identity();
      const response = await (this.options.fetch ?? fetch)(`${this.origin}/${this.options.capability}/api/identity`, { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return isRecord(body) && body.service === "sieun-pi-chat" && body.instanceId === instanceId;
    } catch { return false; }
  }
}
