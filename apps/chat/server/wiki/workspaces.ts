/**
 * A job's wiki workspace (design section 6): `POST /api/c/:id/workspace` opens the job's session folder through the engine's sessions API,
 * stamped with the job's agent, conversation, parent and host, and answers the same folder on every later call; `.../events` appends to
 * its log and `.../close` closes it. An agent's work thread has a standing notebook, `agents/<slug>/work/`, and opens no session.
 * The conversation -> folder map in `<data dir>/wiki-workspaces.json` stands until the engine's `GET /api/agent/sessions?conversation=`
 * answers the same from the log frontmatter.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { agentRecordOf } from "../agent-config.ts";
import type { App } from "../app.ts";
import { readJson, writeJson } from "../store.ts";
import { conversationIdOf } from "../threads.ts";
import type { WikiEngine } from "./engine.ts";
import { knownConversation } from "./identity.ts";
import { answer, readJsonBody, readText, send } from "./reply.ts";

export const WORKSPACE_ROUTE = /^\/api\/c\/([^/]+)\/workspace(?:\/(events|close))?$/;

export interface WorkspaceRow { id: string; path: string; conversation: string; agent: string | null; openedAt: number; closedAt?: number }
interface WorkspaceFile { v: 1; workspaces: Record<string, WorkspaceRow> }

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;
const opening = new Map<string, Promise<void>>();

export function slugOf(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return SLUG.test(slug) ? slug : "job";
}

const fileOf = (app: App) => join(app.config.dataDir, "wiki-workspaces.json");
const load = (app: App): WorkspaceFile => readJson<WorkspaceFile>(fileOf(app), { v: 1, workspaces: {} });
const urlOf = (app: App, path: string) => `${app.config.wikiBase}/${path}`;

export async function serveWorkspace(app: App, engine: WikiEngine, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const [, rawId, verb] = WORKSPACE_ROUTE.exec(path)!;
  const id = decodeURIComponent(rawId!);
  const found = await knownConversation(app, id);
  if (!found) return send(res, 404, { error: `pi-host holds no conversation ${id}.` });
  const agent = agentRecordOf(app, found.conversation);
  const author = agent ? `${agent.slug} (${found.conversation})` : `unknown (${found.conversation})`;
  if (agent && found.conversation === agent.workThread && !verb) {
    const notebook = `agents/${agent.slug}/work/`;
    return send(res, 200, { kind: "notebook", path: notebook, url: urlOf(app, notebook), conversation: found.conversation, agent: agent.id });
  }
  const row = (): WorkspaceRow | undefined => load(app).workspaces[found.conversation];
  if (req.method === "GET" && !verb) {
    const current = row();
    return current ? send(res, 200, { ...current, url: urlOf(app, current.path) }) : send(res, 404, { error: `No workspace for ${found.conversation}.` });
  }
  if (req.method !== "POST") return send(res, 405, { error: `${req.method} ${path} is not a verb here.` });
  const body = readJsonBody(await readText(req));
  if (verb) {
    const current = row();
    if (!current || current.closedAt) return send(res, 404, { error: `No open workspace for ${found.conversation}; POST /api/c/${encodeURIComponent(found.conversation)}/workspace opens one.` });
    const got = await engine.call("POST", `/api/agent/sessions/${encodeURIComponent(current.id)}/${verb}`, { ...body, author });
    if (verb === "close" && got.status >= 200 && got.status < 300) {
      const file = load(app);
      file.workspaces[found.conversation] = { ...current, closedAt: Date.now() };
      writeJson(fileOf(app), file);
    }
    return answer(res, got);
  }
  // Two opens of one conversation at once share the first one's folder.
  while (opening.has(found.conversation)) await opening.get(found.conversation)!.catch(() => undefined);
  const current = row();
  if (current && !current.closedAt) return send(res, 200, { ...current, url: urlOf(app, current.path), opened: false });
  let done!: () => void;
  opening.set(found.conversation, new Promise<void>(resolve => (done = resolve)));
  try {
    const node = found.n === 1 ? undefined : app.threads.tree(found.thread).find(n => n.id === found.n) ?? (await app.host.tree(found.thread)).find(n => n.id === found.n);
    const name = node?.name || app.threads.thread(found.thread)?.name || found.conversation;
    const parent = node ? (node.parent === null ? null : conversationIdOf(found.thread, node.parent)) : app.threads.meta(found.thread).parent ?? null;
    const slug = typeof body.slug === "string" ? body.slug : slugOf(name);
    const pick = (key: string) => (body[key] === undefined ? {} : { [key]: body[key] });
    const got = await engine.call("POST", "/api/agent/sessions", {
      slug, goal: typeof body.goal === "string" && body.goal.trim() ? body.goal : name, title: typeof body.title === "string" ? body.title : name,
      ...pick("description"), ...pick("apps"), ...pick("projects"), ...pick("domains"), ...pick("tags"),
      agent: agent?.slug ?? "unknown", conversation: found.conversation, parent, host: agent?.host ?? app.config.box,
      ...(agent ? { root: `agents/${agent.slug}/jobs` } : {}),
    });
    const opened = got.body as { id?: string; path?: string } | undefined;
    if (got.status >= 200 && got.status < 300 && opened?.id) {
      const folder = opened.id.startsWith("sessions/") || opened.id.startsWith("agents/") ? opened.id : `sessions/${opened.id}`;
      const next: WorkspaceRow = { id: opened.id, path: `${folder}/index.html`, conversation: found.conversation, agent: agent?.id ?? null, openedAt: Date.now() };
      const file = load(app);
      file.workspaces[found.conversation] = next;
      writeJson(fileOf(app), file);
      return send(res, got.status, { ...(got.body as object), ...next, url: urlOf(app, next.path), opened: true });
    }
    return answer(res, got);
  } finally {
    opening.delete(found.conversation);
    done();
  }
}
