import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { parseStartSkill, type NewChatSettings } from "./shared/start-skill.ts";
import type { NewChatPicks } from "./shared/types.ts";

/**
 * `<data dir>/new-chat.json`: the New chat box's settings, the box the owner's last new chat went to, and per box the folder his last new chat
 * there started in. A missing file reads as none of them.
 */
export interface NewChatStore {
  read(): Promise<NewChatSettings>;
  write(next: NewChatSettings): Promise<NewChatSettings>;
  picks(): Promise<NewChatPicks>;
  /** Records a new chat started on `box` in `cwd`. */
  remember(box: string, cwd: string): Promise<void>;
}
type NewChatFile = NewChatSettings & NewChatPicks;

function parseWorkspaces(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

export function newChatStore(path: string): NewChatStore {
  const file: JsonFile<NewChatFile> = {
    path, label: "New chat settings", initial: () => ({ startSkill: null, lastHost: null, lastWorkspace: {} }),
    parse: value => {
      const raw = typeof value === "object" && value !== null ? value as { startSkill?: unknown; lastHost?: unknown; lastWorkspace?: unknown } : {};
      return { startSkill: parseStartSkill(raw.startSkill ?? null), lastHost: typeof raw.lastHost === "string" && raw.lastHost ? raw.lastHost : null,
        lastWorkspace: parseWorkspaces(raw.lastWorkspace) };
    },
  };
  const readFile = () => readJsonFile(file).catch(error => { if (missing(error)) return file.initial(); throw error; });
  return {
    read: async () => ({ startSkill: (await readFile()).startSkill }),
    write: async next => ({ startSkill: (await transactJsonFile(file, state => { state.startSkill = next.startSkill; })).state.startSkill }),
    picks: async () => { const { lastHost, lastWorkspace } = await readFile(); return { lastHost, lastWorkspace }; },
    remember: async (box, cwd) => { await transactJsonFile(file, state => { state.lastHost = box; state.lastWorkspace = { ...state.lastWorkspace, [box]: cwd }; }); },
  };
}
