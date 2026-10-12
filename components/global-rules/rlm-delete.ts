import type { ExtensionContext, ToolCallEvent } from "prime-agent";
import { enabled, log } from "./log.ts";

/**
 * Works around a Prime 0.9.8 bug: a subagent that deletes a child still in its turn fails with "RLM quiescence wait
 * cancelled". See README "rlm-delete.ts". Delete this module once Prime stops aborting a parent's wait from a child's abort.
 */
export const SETTLE_SECONDS = 90;

const DELETE_CALL = /\bdelete_subagent\s*\(/;

export const PRELUDE_SOURCE = `
import asyncio, time
import rlm as m
ns = m._RLMNamespace
if not getattr(ns.delete_subagent, "settle_first", False):
    def key(target):
        if isinstance(target, str):
            return target.strip()
        return getattr(target, "rlm_child_id", None)
    def matches(row, wanted):
        return wanted in (row.rlm_child_id, row.session_name, row.session_id, row.active_session_id)
    async def settle(target):
        wanted = key(target)
        deadline = time.monotonic() + ${SETTLE_SECONDS}
        while time.monotonic() < deadline:
            row = next((r for r in await m.list_subagents() if matches(r, wanted)), None)
            if row is None or not row.replied_since_task:
                return
            if row.status != "running" and row.activity is None:
                await asyncio.sleep(1)
                return
            await asyncio.sleep(1)
    async def delete_subagent(self, target):
        try:
            await settle(target)
        except Exception:
            pass
        return await m.delete_subagent(target)
    delete_subagent.settle_first = True
    ns.delete_subagent = delete_subagent
`;

/** One line, so the cell's own line numbers in a traceback move by one. */
export const PRELUDE = `exec(compile(${JSON.stringify(PRELUDE_SOURCE)}, "<global-rules rlm-delete>", "exec"), {})\n`;

export function settleBeforeDelete(code: unknown, depth: number): string | undefined {
	if (depth < 1 || typeof code !== "string" || !DELETE_CALL.test(code) || code.startsWith(PRELUDE)) return undefined;
	return PRELUDE + code;
}

function depthOf(header: { rlmDepth?: number; parentSession?: string } | null | undefined): number {
	return header?.rlmDepth ?? (header?.parentSession ? 1 : 0);
}

/** A handler error fails open: the cell then runs unchanged. */
export function onToolCall(event: ToolCallEvent, ctx: Partial<Pick<ExtensionContext, "sessionManager">> | undefined): undefined {
	try {
		if (!enabled("GLOBAL_RULES_RLM_DELETE") || event.toolName !== "ipython") return undefined;
		const input = event.input as Record<string, unknown>;
		const code = settleBeforeDelete(input.code, depthOf(ctx?.sessionManager?.getHeader()));
		if (code !== undefined) input.code = code;
	} catch (err) {
		log("rlm-delete", `handler error, cell runs unchanged :: ${err instanceof Error ? err.stack : String(err)}`);
	}
	return undefined;
}
