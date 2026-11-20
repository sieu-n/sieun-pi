/**
 * Skills: the inventory of every skill on the boxes, which sieun-pi's scripts/skills-inventory.py writes to ~/work/skills-health/inventory.json,
 * served to the Skills section of Settings (GET /api/skills). Every read starts a scan unless one runs, so the page opens on the last
 * inventory at once and moves to the new one when the scan ends; `wait` answers after the running scan. The scanner is the one tool that
 * builds the inventory, so this module only runs it and reads its file.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { NotFound } from "./app.ts";
import { parseInventory, type SkillDoc, type SkillInventory, type SkillsReport } from "../web/src/lib/api/shared/skills.ts";

export type SkillsConfig = {
  /** The inventory file the scanner writes. */
  inventory: string;
  /** The scanner and its folder, or null where none runs, as on the fixture. */
  scanner: { command: string; args: string[]; cwd: string } | null;
};

export class Skills {
  private running: Promise<void> | null = null;
  private scan: SkillsReport["scan"] = { running: false, startedAt: null, endedAt: null, error: null };

  constructor(private readonly config: SkillsConfig, private readonly box: string, private readonly log: (line: string) => void = () => {}) {}

  /** The last inventory, after starting a scan when none runs; with `wait`, the inventory after the running scan, and no new scan. */
  async report(opts: { wait?: boolean } = {}): Promise<SkillsReport> {
    if (opts.wait) await this.running;
    else void this.start();
    const read = await this.read();
    return { inventory: read.inventory, readError: read.error, scan: { ...this.scan } };
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

  private start(): Promise<void> {
    const scanner = this.config.scanner;
    if (!scanner) return Promise.resolve();
    if (this.running) return this.running;
    this.scan = { running: true, startedAt: Date.now(), endedAt: null, error: null };
    this.running = new Promise<void>(resolve => {
      let stderr = "";
      const finish = (failure: string | null) => {
        if (failure) this.log(`skills: the scan failed: ${failure}`);
        this.scan = { running: false, startedAt: this.scan.startedAt, endedAt: Date.now(), error: failure };
        this.running = null;
        resolve();
      };
      const child = spawn(scanner.command, scanner.args, { cwd: scanner.cwd, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", error => finish(error.message));
      child.on("close", (code, signal) => finish(code === 0 ? null : stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code ?? signal}`));
    });
    return this.running;
  }

  /** The inventory, and its raw rows for the fields the page does not get, such as a row's carried `text`. */
  private async read(): Promise<{ inventory: SkillInventory | null; raw: Record<string, unknown>[]; error: string | null }> {
    let text: string;
    try {
      text = await readFile(this.config.inventory, "utf8");
    } catch {
      return { inventory: null, raw: [], error: `No inventory at ${this.config.inventory} yet.` };
    }
    try {
      const json = JSON.parse(text) as { skills?: unknown };
      const inventory = parseInventory(json);
      const raw = Array.isArray(json.skills) ? (json.skills as Record<string, unknown>[]) : [];
      return inventory ? { inventory, raw, error: null } : { inventory: null, raw: [], error: `${this.config.inventory} holds no skills list.` };
    } catch (reason) {
      return { inventory: null, raw: [], error: `${this.config.inventory} is not JSON: ${reason instanceof Error ? reason.message : String(reason)}` };
    }
  }
}
