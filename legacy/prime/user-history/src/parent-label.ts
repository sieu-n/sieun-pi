/**
 * Prime 0.9.8 writes a subagent's base prompt line "You are a child agent spawned by <parent>." with the parent session's name when it spawns
 * the child (createRlmSubagentRuntime: parentSession.sessionName ?? sessionId), and with "your parent agent" when the daemon loads the child
 * again after an unload or passivation, since that path passes no rlmParentAgent. The changed line made Anthropic write the child's whole prompt
 * cache again: 18 of the 42 system prompt changes the prompt captures on us-metal02 showed between 16:46Z and 18:20Z on 10-23.
 * The child records the name its first load saw and puts it back into the line of every request after a later load.
 */
export const PARENT_LABEL_ENTRY = "sieun-parent-label";
const GENERIC = "your parent agent";
const LINE = /You are a child agent spawned by (.+?)\. Task prompts are labeled/;

type Entry = { type: string; customType?: string; data?: unknown };

export function storedParentLabel(entries: readonly Entry[]): string | null {
  const label = (entries.findLast(entry => entry.type === "custom" && entry.customType === PARENT_LABEL_ENTRY)?.data as { label?: unknown } | undefined)?.label;
  return typeof label === "string" && label !== GENERIC ? label : null;
}

/** `record` is the parent name to store, from a first load; `text` is the system text with the stored name back in the line. */
export function parentLabelText(text: string, stored: string | null): { record?: string | undefined; text?: string | undefined } {
  const label = LINE.exec(text)?.[1];
  if (label === undefined) return {};
  if (label !== GENERIC) return stored === null ? { record: label } : {};
  if (stored === null) return {};
  return { text: text.replace(`spawned by ${GENERIC}. Task prompts are labeled`, () => `spawned by ${stored}. Task prompts are labeled`) };
}

/** The same for a provider payload: Anthropic's `system` (a string or text blocks) or OpenAI Responses' `instructions`. */
export function withParentLabel(payload: unknown, stored: string | null): { record?: string | undefined; payload?: unknown } {
  if (typeof payload !== "object" || payload === null) return {};
  const body = payload as Record<string, unknown>;
  for (const key of ["system", "instructions"] as const) {
    const value = body[key];
    if (typeof value === "string") {
      const { record, text } = parentLabelText(value, stored);
      if (record || text) return { record, payload: text ? { ...body, [key]: text } : undefined };
    }
    if (Array.isArray(value)) for (const [index, block] of value.entries()) {
      const blockText = (block as { text?: unknown } | null)?.text;
      if (typeof blockText !== "string") continue;
      const { record, text } = parentLabelText(blockText, stored);
      if (!record && !text) continue;
      return { record, payload: text ? { ...body, [key]: value.map((item, at) => at === index ? { ...(item as object), text } : item) } : undefined };
    }
  }
  return {};
}
