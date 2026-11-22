/**
 * Skills: the inventory of every skill on the boxes, which sieun-pi's scripts/skills-inventory.py writes to ~/work/skills-health/inventory.json,
 * served to the Skills section of Settings (GET /api/skills). A read answers from the parsed inventory this module keeps, which it reads
 * again only when the file's change time or size moved, and it never starts or waits for a scan. POST /api/skills/scan starts one, and its
 * start and end go to every page as a `skills` live event, after the new inventory is parsed. On 11-20 a read that started the scanner,
 * or waited for it, took p90 2.2 s and once 118 s, and each read parsed the 725 KB file again. The scanner is the one tool that builds the
 * inventory, so this module only runs it and reads its file.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NotFound } from "./app.ts";
import { parseInventory, type SkillDoc, type SkillInventory, type SkillScan, type SkillsReport } from "../web/src/lib/api/shared/skills.ts";

export type SkillsConfig = {
  /** The inventory file the scanner writes. */
  inventory: string;
  /** The scanner and its folder, or null where none runs, as on the fixture. */
  scanner: { command: string; args: string[]; cwd: string; env?: Record<string, string> } | null;
};

/**
 * What the skills DB adds to the scanner (server/skills-db.ts): it takes each new inventory, gives the review its rule verdicts, and says
 * when a box was last scanned, for the schedule.
 */
export type SkillsHooks = {
  ingest: (json: unknown) => void;
  overlay: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  lastAttempt: () => number | null;
  /** Each box's install paths, which the scanner also reads where they sit outside every folder it walks, such as a scratch path. */
  installPaths?: () => Record<string, string[]>;
};

/**
 * The scan runs every hour inside the chat server. A full scan of both boxes took 72 s on metal and 72 s on the Mac when its use caches were
 * rebuilt on 11-21, and 11 s and 4 s with warm caches, so an hourly scan keeps the use counts and drift under an hour old for about 2% of
 * one core. In the server it shares the single running scan with POST /api/skills/scan, and needs no unit on each box beside the server.
 */
export const SCAN_EVERY_MS = 60 * 60_000;
/** How often the server looks whether the hourly scan is due, so a restart scans within ten minutes of when it was due. */
const SCAN_CHECK_MS = 10 * 60_000;

/** The inventory file as last parsed, its raw rows for the fields the page does not get, such as a row's carried `text`. */
type Read = { inventory: SkillInventory | null; raw: Record<string, unknown>[]; error: string | null };

/** The parsed file and the change time and size it was parsed at, or "missing" when no file was there. */
type Parsed = { stamp: string; read: Read };

export class Skills {
  private running: Promise<void> | null = null;
  private scan: SkillScan = { running: false, startedAt: null, endedAt: null, error: null };
  private parsed: Promise<Parsed> | null = null;
  private hooks: SkillsHooks | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: SkillsConfig,
    private readonly box: string,
    private readonly log: (line: string) => void = () => {},
    private readonly onScan: (scan: SkillScan) => void = () => {},
  ) {
    void this.read();
  }

  /** The last inventory and the scan state, from the parsed copy unless the file changed since. */
  async report(): Promise<SkillsReport> {
    const read = await this.read();
    return { inventory: read.inventory, readError: read.error, scan: { ...this.scan } };
  }

  /** The inventory's raw rows, with the fields the page does not get and the rule verdicts as `useful`, for the skills review (server/skills-review.ts). */
  async rawRows(): Promise<{ rows: Record<string, unknown>[]; generatedAt: string | null; error: string | null }> {
    const read = await this.read();
    return { rows: this.hooks ? this.hooks.overlay(read.raw) : read.raw, generatedAt: read.inventory?.generatedAt ?? null, error: read.error };
  }

  /** Joins the skills DB: every inventory parsed from now on is ingested, and the hourly scan starts when one is due. */
  attach(hooks: SkillsHooks, schedule: boolean): void {
    this.hooks = hooks;
    void this.read().then(() => this.ingestCurrent());
    if (!schedule || !this.config.scanner) return;
    const tick = () => {
      const last = hooks.lastAttempt();
      if (!this.running && (last === null || Date.now() - last >= SCAN_EVERY_MS)) void this.start();
    };
    this.timer = setInterval(tick, SCAN_CHECK_MS);
    this.timer.unref();
    setTimeout(tick, hooks.lastAttempt() === null ? 0 : 30_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private json: unknown = null;

  private ingestCurrent(): void {
    if (!this.hooks || this.json === null) return;
    try {
      this.hooks.ingest(this.json);
    } catch (error) {
      this.log(`skills: the ingest failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }

  /** Starts a scan unless one runs, and answers the scan state at once. `done` settles when that scan ends and its inventory is parsed. */
  startScan(): { scan: SkillScan; done: Promise<void> } {
    const done = this.start();
    return { scan: { ...this.scan }, done };
  }

  /** The SKILL.md of one row: the text the scanner carried for a row off this box, else the file the row names on this box. */
  async doc(id: string): Promise<SkillDoc> {
    const { inventory, raw, error } = await this.read();
    const row = inventory?.skills.find(skill => skill.id === id);
    if (!inventory || !row) throw new NotFound(error ?? `No skill ${id} in the inventory.`);
    const related = inventory.skills.filter(other => other.id !== id && (row.duplicateOf.includes(other.id) || other.duplicateOf.includes(id) || other.id === row.useful.mergeInto));
    const carried = raw.find(entry => entry.id === id)?.text;
    if (typeof carried === "string") return { row, text: carried, textError: null, related };
    if (row.box !== this.box) return { row, text: null, textError: `${row.name} lives on ${row.box}, and the inventory carries no text for it.`, related };
    try {
      return { row, text: await readFile(row.path, "utf8"), textError: null, related };
    } catch (reason) {
      return { row, text: null, textError: `${row.path} did not read: ${reason instanceof Error ? reason.message : String(reason)}`, related };
    }
  }

  /** Writes the skills DB's install paths beside the inventory, for the scanner's --install-paths. */
  private async installArgs(): Promise<string[]> {
    const paths = this.hooks?.installPaths?.();
    if (!paths) return [];
    const file = join(dirname(this.config.inventory), "install-paths.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(paths));
    return ["--install-paths", file];
  }

  private start(): Promise<void> {
    const scanner = this.config.scanner;
    if (!scanner) return Promise.resolve();
    if (this.running) return this.running;
    this.scan = { running: true, startedAt: Date.now(), endedAt: null, error: null };
    this.onScan({ ...this.scan });
    this.running = this.installArgs().catch(() => [] as string[]).then(extra => new Promise<void>(resolve => {
      let stderr = "";
      const finish = async (failure: string | null) => {
        if (failure) this.log(`skills: the scan failed: ${failure}`);
        await this.read();
        this.scan = { running: false, startedAt: this.scan.startedAt, endedAt: Date.now(), error: failure };
        this.running = null;
        this.onScan({ ...this.scan });
        resolve();
      };
      const child = spawn(scanner.command, [...scanner.args, ...extra], { cwd: scanner.cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...scanner.env } });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", error => void finish(error.message));
      child.on("close", (code, signal) => void finish(code === 0 ? null : stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code ?? signal}`));
    }));
    return this.running;
  }

  /** The parsed inventory, parsed again only when the file's change time or size moved; reads that arrive during a parse share it. */
  private async read(): Promise<Read> {
    const stamp = await stat(this.config.inventory).then(s => `${s.mtimeMs}:${s.size}`, () => "missing");
    const current = this.parsed;
    if (current) {
      const last = await current;
      if (last.stamp === stamp) return last.read;
      if (this.parsed !== current) return this.read();
    }
    const next = this.parse(stamp);
    this.parsed = next;
    return (await next).read;
  }

  private async parse(stamp: string): Promise<Parsed> {
    if (stamp === "missing") return { stamp, read: { inventory: null, raw: [], error: `No inventory at ${this.config.inventory} yet.` } };
    let text: string;
    try {
      text = await readFile(this.config.inventory, "utf8");
    } catch {
      return { stamp: "missing", read: { inventory: null, raw: [], error: `No inventory at ${this.config.inventory} yet.` } };
    }
    try {
      const json = JSON.parse(text) as { skills?: unknown };
      this.json = json;
      this.ingestCurrent();
      const inventory = parseInventory(json);
      const raw = Array.isArray(json.skills) ? (json.skills as Record<string, unknown>[]) : [];
      return { stamp, read: inventory ? { inventory, raw, error: null } : { inventory: null, raw: [], error: `${this.config.inventory} holds no skills list.` } };
    } catch (reason) {
      return { stamp, read: { inventory: null, raw: [], error: `${this.config.inventory} is not JSON: ${reason instanceof Error ? reason.message : String(reason)}` } };
    }
  }
}
