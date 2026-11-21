/**
 * Consoles: the consoles table that auto-sns-agent keeps in apps/infra/metal/config/consoles.json, served to the Consoles section of Settings
 * (GET /api/consoles). apps/chat runs on us-metal02 only, beside that box's auto-sns-agent checkout, so each read takes the file from that
 * checkout as it is now, the same file the wiki page domains/devops/consoles renders, and no copy can fall behind it.
 */
import { readFile } from "node:fs/promises";
import { parseConsoles, type ConsolesReport } from "../web/src/lib/api/shared/consoles.ts";

export async function consolesReport(file: string): Promise<ConsolesReport> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    return { table: null, readError: (error as NodeJS.ErrnoException).code === "ENOENT" ? `No consoles file at ${file}` : String(error), file };
  }
  try {
    const table = parseConsoles(JSON.parse(raw));
    return table ? { table, readError: null, file } : { table: null, readError: `${file} has no tiers or consoles list`, file };
  } catch (error) {
    return { table: null, readError: `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`, file };
  }
}
