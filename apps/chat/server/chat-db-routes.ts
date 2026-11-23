/**
 * The routes of `sw <kind> check|apply` for each kind of record moved from the JSON files into chat.sqlite (json-move.ts), and GET /api/db,
 * which checks every kind at once.
 */
import type { IncomingMessage } from "node:http";
import { NotFound } from "./app.ts";
import type { JsonMove, MoveApply, MoveCheck } from "./json-move.ts";

type Handler = (req: IncomingMessage, params: Record<string, string>, query: URLSearchParams, body: () => Promise<unknown>) => Promise<unknown>;

export function chatDbRoutes<R>(moves: () => ReadonlyMap<string, JsonMove>, route: (method: string, path: string, handler: Handler) => R): R[] {
  const move = (kind: string | undefined): JsonMove => {
    const found = kind === undefined ? undefined : moves().get(kind);
    if (!found) throw new NotFound(`chat.sqlite has no kind ${kind}; its kinds are ${[...moves().keys()].join(", ") || "none yet"}.`);
    return found;
  };
  return [
    route("GET", "/api/db", async (): Promise<{ kinds: MoveCheck[] }> => ({ kinds: [...moves().values()].map(m => m.check()) })),
    route("GET", "/api/db/:kind/check", async (_r, p): Promise<MoveCheck> => move(p.kind).check()),
    route("POST", "/api/db/:kind/apply", async (_r, p, _q, body): Promise<MoveApply> => {
      const raw = await body();
      return move(p.kind).apply({ dryRun: !!raw && typeof raw === "object" && (raw as { dryRun?: unknown }).dryRun === true });
    }),
  ];
}
