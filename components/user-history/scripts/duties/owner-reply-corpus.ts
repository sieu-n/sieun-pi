import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Projector } from "../../src/chat-projection.ts";
import { historyMessages, readBranchPage } from "../../src/session-tail.ts";
import { chatLines } from "../../src/shared/chat-feed.ts";

/**
 * The owner's real chats as he saw them, for measuring how long the messages he corrected ran against the ones he let stand (c18, c104): one
 * JSON line per owner message and per message a chat sent him, oldest first, from the :5182 feed's own reader (chatLines). Clean-room chats are
 * left out. No model call and no write outside OUTPUT_FILE.
 *
 *   OUTPUT_FILE=<file.jsonl> node --import tsx scripts/duties/owner-reply-corpus.ts [--days 14] [--end <ISO>]
 */
const DATA = process.env.CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const PLACES = [join(homedir(), ".prime/agent/sessions"), join(homedir(), ".cache/sieun-pi/hosts/mac/Users/sieunpark/.prime/agent/sessions")];
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const end = opt("--end") ? Date.parse(opt("--end")!) : Date.now();
const start = end - Number(opt("--days") ?? 14) * 86_400_000;
const out = process.env.OUTPUT_FILE;
if (!out) { process.stderr.write("OUTPUT_FILE is not set\n"); process.exit(2); }

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
const testChats = new Set(JSON.stringify(readJson(join(DATA, "clean-room-chats.json"), {})).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
const ids = readJson<{ ids?: string[] }>(join(DATA, "chats.json"), {}).ids ?? [];
const archived = JSON.stringify(readJson(join(DATA, "archived-chats.json"), {})).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
const chats = [...new Set([...ids, ...archived])].filter(id => !testChats.has(id));
const projector = new Projector({ put: () => "x", link: () => {} } as never);

async function branchSince(file: string, since: number): Promise<any[]> {
  let from = null; const pages: any[][] = [];
  for (;;) {
    const page = await readBranchPage(file, from, { messages: 2000, bytes: 16 * 1024 * 1024 });
    if (!page) return [];
    pages.unshift(page.entries);
    if (!page.before || (page.entries.length ? Date.parse(page.entries[0]!.timestamp) : 0) < since) break;
    from = page.before;
  }
  return pages.flat();
}

const rows: string[] = [];
for (const chat of chats) {
  const file = PLACES.map(dir => join(dir, `${chat}.jsonl`)).find(existsSync);
  if (!file) continue;
  const messages = projector.messages(historyMessages(await branchSince(file, start)));
  for (const line of chatLines(messages) as any[]) {
    if ((line.kind !== "agent" && line.kind !== "user") || line.pending || line.at < start || line.at >= end) continue;
    rows.push(JSON.stringify({ chat, id: line.id, at: line.at, kind: line.kind, text: line.text }));
  }
}
writeFileSync(out, rows.join("\n") + "\n");
process.stdout.write(`${rows.length} lines from ${chats.length} chats\n`);
