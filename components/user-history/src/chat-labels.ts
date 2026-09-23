import { randomBytes } from "node:crypto";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { PROGRESS_STEPS, type LabelAction, type Priority, type Progress, type Tag, type ThreadLabels } from "./shared/types.ts";

export interface LabelsState { tags: Tag[]; threads: Record<string, ThreadLabels> }
export const TAG_NAME_MAX = 40;
const HUES = [262, 200, 150, 90, 40, 12, 330, 290] as const;

export class LabelError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isPriority = (value: unknown): value is Priority => value === 0 || value === 1 || value === 2 || value === 3;
export const isProgress = (value: unknown): value is Progress => (PROGRESS_STEPS as readonly unknown[]).includes(value);

function parse(value: unknown): LabelsState {
  if (!isRecord(value) || !Array.isArray(value.tags) || !isRecord(value.threads)) throw new Error("Invalid browser labels");
  const tags = value.tags.map(tag => {
    if (!isRecord(tag) || typeof tag.id !== "string" || typeof tag.name !== "string" || typeof tag.hue !== "number") throw new Error("Invalid browser tag");
    return { id: tag.id, name: tag.name, hue: tag.hue };
  });
  const known = new Set(tags.map(tag => tag.id));
  const threads: Record<string, ThreadLabels> = Object.create(null);
  for (const [id, entry] of Object.entries(value.threads)) {
    if (!isRecord(entry) || !Array.isArray(entry.tags) || !isPriority(entry.priority)) throw new Error("Invalid browser thread labels");
    if (entry.progress !== undefined && !isProgress(entry.progress)) throw new Error("Invalid browser thread progress");
    threads[id] = { tags: entry.tags.filter((tag): tag is string => typeof tag === "string" && known.has(tag)), priority: entry.priority, progress: entry.progress ?? "none" };
  }
  return { tags, threads };
}

export function tagName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > TAG_NAME_MAX) throw new LabelError(400, `Use a tag name of 1 to ${TAG_NAME_MAX} characters.`);
  return name;
}

function entry(state: LabelsState, id: string): ThreadLabels {
  return state.threads[id] ??= { tags: [], priority: 0, progress: "none" };
}

function prune(state: LabelsState): void {
  for (const [id, labels] of Object.entries(state.threads)) if (!labels.tags.length && labels.priority === 0 && labels.progress === "none") delete state.threads[id];
}

/** Applies one action to the state in place. Creating a tag that already exists (by name, any case) reuses it. */
export function applyLabelAction(state: LabelsState, action: LabelAction): string | undefined {
  const find = (tagId: string): Tag => {
    const tag = state.tags.find(candidate => candidate.id === tagId);
    if (!tag) throw new LabelError(404, "That tag no longer exists.");
    return tag;
  };
  const byName = (name: string) => state.tags.find(tag => tag.name.toLowerCase() === name.toLowerCase());
  let result: string | undefined;
  switch (action.op) {
    case "create": {
      const name = tagName(action.name);
      let tag = byName(name);
      if (!tag) {
        tag = { id: "t" + randomBytes(5).toString("hex"), name, hue: HUES[state.tags.length % HUES.length]! };
        state.tags.push(tag);
      }
      for (const id of action.ids) { const labels = entry(state, id); if (!labels.tags.includes(tag.id)) labels.tags.push(tag.id); }
      result = tag.id;
      break;
    }
    case "rename": {
      const tag = find(action.tagId);
      const name = tagName(action.name);
      const clash = byName(name);
      if (clash && clash.id !== tag.id) throw new LabelError(409, `A tag named ${clash.name} already exists.`);
      tag.name = name;
      break;
    }
    case "delete":
      find(action.tagId);
      state.tags = state.tags.filter(tag => tag.id !== action.tagId);
      for (const labels of Object.values(state.threads)) labels.tags = labels.tags.filter(tag => tag !== action.tagId);
      break;
    case "tag":
      find(action.tagId);
      for (const id of action.ids) {
        const labels = entry(state, id);
        if (!action.on) labels.tags = labels.tags.filter(tag => tag !== action.tagId);
        else if (!labels.tags.includes(action.tagId)) labels.tags.push(action.tagId);
      }
      break;
    case "priority":
      for (const id of action.ids) entry(state, id).priority = action.priority;
      break;
    case "progress":
      for (const id of action.ids) entry(state, id).progress = action.progress;
      break;
  }
  prune(state);
  return result;
}

export class ChatLabels {
  private readonly file: JsonFile<LabelsState>;
  constructor(path: string) { this.file = { path, label: "Browser labels", parse, initial: () => ({ tags: [], threads: Object.create(null) }) }; }
  snapshot(): Promise<LabelsState> { return snapshotJsonFile(this.file); }
  async apply(action: LabelAction): Promise<{ tagId?: string }> {
    const { result } = await transactJsonFile(this.file, state => applyLabelAction(state, action));
    return result ? { tagId: result } : {};
  }
}
