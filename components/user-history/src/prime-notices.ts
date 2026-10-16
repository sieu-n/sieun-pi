/**
 * Prime's own notices, shortened for the model. `[python-state]` lists every name left in the kernel after a compaction (4,000 characters in a
 * busy chat), `[python-state-restored]` every name a revive brought back, and a `[<source>-refinement]` notice carries every edit's text. The model
 * needs the count and the refinement's title, id and the entries it saved (kind:id); `dir()` and the harness hold the rest. Each replacement depends only on the message itself,
 * so every model call sends the same bytes and the cached prompt prefix stays valid.
 */

type Notice = { role?: unknown; customType?: unknown; content?: unknown; details?: unknown };

const NAMES = /( These names are still defined| These names are available again): ([^\n]*?)\.(?=\n|$)/;

function shortState(content: string): string | null {
  const match = NAMES.exec(content);
  if (!match) return null;
  const count = match[2]!.split(", ").filter(Boolean).length;
  const verb = match[1]!.includes("again") ? "are available again" : "are still defined";
  return content.replace(match[0], ` ${count} names ${verb}; run dir() to list them.`);
}

function shortRefinement(content: string, details: unknown): string | null {
  const header = /^\[[a-z]+-refinement\]/.exec(content)?.[0];
  if (!header) return null;
  const info = typeof details === "object" && details !== null ? details as { refinementId?: unknown; summary?: unknown; edits?: unknown } : {};
  const title = typeof info.summary === "string" && info.summary ? info.summary : content.slice(header.length).trim().split("\n")[0] ?? "";
  const id = typeof info.refinementId === "string" ? ` (${info.refinementId})` : "";
  // The entries it saved, so the next turn knows which note or memory to follow or read in full (clean room 10-16: the title alone named none).
  const saved = (Array.isArray(info.edits) ? info.edits : []).flatMap(edit => {
    const { action, kind, id } = (typeof edit === "object" && edit !== null ? edit : {}) as { action?: unknown; kind?: unknown; id?: unknown };
    return typeof kind === "string" && typeof id === "string" ? [`${action === "delete" ? "deleted " : ""}${kind}:${id}`] : [];
  });
  return `${header} Refinement saved: ${title}${id}${saved.length ? `; entries: ${saved.join(", ")}` : ""}`;
}

/** The short text for one Prime notice, or null when the message is no notice this shortens. */
export function shortNotice(message: Notice): string | null {
  if (message.role !== "custom" || typeof message.content !== "string") return null;
  if (message.customType === "ipython_state" || message.customType === "ipython_state_restored") return shortState(message.content);
  if (message.customType === "refinement_notice") return shortRefinement(message.content, message.details);
  return null;
}

/** The messages with every Prime notice shortened, as a new array; undefined when none changed. The input is never mutated. */
export function shortNotices<T>(messages: readonly T[]): T[] | undefined {
  let changed = false;
  const out = messages.map(message => {
    const text = shortNotice(message as Notice);
    if (text === null || text === (message as Notice).content) return message;
    changed = true;
    return { ...message, content: text };
  });
  return changed ? out : undefined;
}
