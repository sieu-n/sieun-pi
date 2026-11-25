/**
 * Gives every live agent with an area the two common duties of c249 (server/common-duties.ts), as `App.createAgent` gives a new one, and
 * reruns safely: an agent's own "Area review" keeps its precheck, prompt and schedule, and only a precheck cwd the chat host lacks moves
 * (`areaReviewUpdate`). A check-in still on the old 120 min default goes to the 3-hourly board push; any other interval stays.
 * An agent with no brief and no duty has no area and gets nothing, as feature probe on 11-26.
 *
 * Usage: node scripts/common-duties-backfill.ts [--server http://127.0.0.1:5184] [--db <chat.sqlite>] [--agents-dir <dir>] [--dry-run]
 * It reads chat.sqlite read-only and writes through the chat server's duties and check-in routes, then prints one JSON line per agent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { AREA_REVIEW_NAME, areaReviewUpdate, BOARD_PUSH_EVERY_MS, type StoredDuty } from "../server/common-duties.ts";

const OLD_CHECK_IN_MS = 120 * 60_000;

interface AgentRow { id: string; slug: string; name: string; home?: string; archived?: boolean; test?: true }
interface DutiesFile { duties?: StoredDuty[]; checkIn?: { everyMs?: number } }

const { values } = parseArgs({ options: { server: { type: "string" }, db: { type: "string" }, "agents-dir": { type: "string" }, "dry-run": { type: "boolean" } } });
const server = values.server ?? "http://127.0.0.1:5184";
const dbPath = values.db ?? join(process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"), "chat.sqlite");
const agentsDir = values["agents-dir"] ?? join(homedir(), ".pi/agent/agents");

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${server}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const agents = (db.prepare("SELECT body FROM agents_agents ORDER BY ord").all() as { body: string }[]).map(r => JSON.parse(r.body) as AgentRow);
const fileOf = (id: string): DutiesFile => {
  const row = db.prepare("SELECT body FROM duties_files WHERE path = ?").get(`agents/${id}/duties.json`) as { body: string } | undefined;
  return row ? JSON.parse(row.body) as DutiesFile : {};
};
for (const agent of agents.filter(a => !a.archived && !a.test)) {
  const file = fileOf(agent.id);
  const duties = file.duties ?? [];
  const briefFile = join(agentsDir, agent.slug, "brief.md");
  const brief = existsSync(briefFile) && readFileSync(briefFile, "utf8").trim() !== "";
  if (!brief && !duties.length) {
    console.log(JSON.stringify({ agent: agent.id, skipped: "no brief and no duty, so no area" }));
    continue;
  }
  const existing = duties.find(duty => duty.name === AREA_REVIEW_NAME);
  const duty = areaReviewUpdate(existing, agent.id, agent.home);
  const review = !duty ? "kept" : values["dry-run"] ? (existing ? "would move its cwd" : "would add") : String((await post(`/api/agents/${agent.id}/duties`, { action: "set", duty })).result);
  const everyMs = file.checkIn?.everyMs;
  const checkIn = everyMs !== OLD_CHECK_IN_MS ? `kept ${everyMs ?? "default"}` : values["dry-run"] ? "would set 180 min"
    : (await post(`/api/agents/${agent.id}/check-in`, { everyMs: BOARD_PUSH_EVERY_MS }), "set 180 min");
  console.log(JSON.stringify({ agent: agent.id, review, checkIn }));
}
db.close();
