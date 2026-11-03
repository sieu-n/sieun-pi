/**
 * A job's wiki workspace (design section 6): `POST /api/c/:id/workspace` opens the job's session folder through the engine's sessions API,
 * stamped with the job's agent, conversation, parent and host, and answers the same folder on every later call; `.../events` appends to
 * its log and `.../close` closes it. An agent's work thread has a standing notebook, `agents/<slug>/work/`, and opens no session.
 * The log frontmatter is the record: the open folder of a conversation is the engine's `GET /api/agent/sessions?status=open&conversation=`.
 * The engine's index lists a new log about 5 s after the write, so the folders this process opened answer from memory until it does.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { agentRecordOf } from "../agent-config.ts";
import type { App } from "../app.ts";
import { conversationIdOf } from "../threads.ts";
import type { WikiEngine } from "./engine.ts";
import { knownConversation } from "./identity.ts";
import { answer, readJsonBody, readText, send } from "./reply.ts";

export const WORKSPACE_ROUTE = /^\/api\/c\/([^/]+)\/workspace(?:\/(events|close))?$/;

export interface Workspace { id: string; path: string; conversation: string; agent: string | null }

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;
/** Folders opened by this process that the engine's index may not list yet, by conversation. */
const recent = new Map<string, Workspace>();
const opening = new Map<string, Promise<void>>();

export function slugOf(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return SLUG.test(slug) ? slug : "job";
}

const urlOf = (app: App, path: string) => `${app.config.wikiBase}/${path}`;

/** The conversation's open folder: the engine's answer, else one this process opened in the last index refresh. */
async function openWorkspace(engine: WikiEngine, conversation: string): Promise<Workspace | undefined> {
  const got = await engine.call("GET", `/api/agent/sessions?status=open&conversation=${encodeURIComponent(conversation)}`);
  const rows = got.status === 200 ? ((got.body as { sessions?: { id: string; agent?: string }[] }).sessions ?? []) : [];
  const row = rows.at(-1);
  if (row) return { id: row.id, path: `${row.id}/index.html`, conversation, agent: row.agent ?? null };
  return recent.get(conversation);
}

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
  if (req.method === "GET" && !verb) {
    const current = await openWorkspace(engine, found.conversation);
    return current ? send(res, 200, { ...current, url: urlOf(app, current.path) }) : send(res, 404, { error: `No open workspace for ${found.conversation}.` });
  }
  if (req.method !== "POST") return send(res, 405, { error: `${req.method} ${path} is not a verb here.` });
  const body = readJsonBody(await readText(req));
  if (verb) {
    const current = await openWorkspace(engine, found.conversation);
    if (!current) return send(res, 404, { error: `No open workspace for ${found.conversation}; POST /api/c/${encodeURIComponent(found.conversation)}/workspace opens one.` });
    const got = await engine.call("POST", `/api/agent/sessions/${encodeURIComponent(current.id)}/${verb}`, { ...body, author });
    if (verb === "close" && got.status >= 200 && got.status < 300) recent.delete(found.conversation);
    return answer(res, got);
  }
  // Two opens of one conversation at once share the first one's folder.
  while (opening.has(found.conversation)) await opening.get(found.conversation)!.catch(() => undefined);
  let done!: () => void;
  opening.set(found.conversation, new Promise<void>(resolve => (done = resolve)));
  try {
    const current = await openWorkspace(engine, found.conversation);
    if (current) return send(res, 200, { ...current, url: urlOf(app, current.path), opened: false });
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
    const opened = got.body as { id?: string } | undefined;
    if (got.status >= 200 && got.status < 300 && opened?.id) {
      const next: Workspace = { id: opened.id, path: `${opened.id}/index.html`, conversation: found.conversation, agent: agent?.id ?? null };
      recent.set(found.conversation, next);
      return send(res, got.status, { ...(got.body as object), ...next, url: urlOf(app, next.path), opened: true });
    }
    return answer(res, got);
  } finally {
    opening.delete(found.conversation);
    done();
  }
}
