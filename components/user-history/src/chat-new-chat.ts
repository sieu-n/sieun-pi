import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { parseStartSkill, type NewChatSettings } from "./shared/start-skill.ts";

/** `<data dir>/new-chat.json`: the New chat box's settings and the box the owner's last new chat went to. A missing file reads as neither. */
export interface NewChatStore {
  read(): Promise<NewChatSettings>;
  write(next: NewChatSettings): Promise<NewChatSettings>;
  lastHost(): Promise<string | null>;
  setLastHost(name: string): Promise<void>;
}
type NewChatFile = NewChatSettings & { lastHost: string | null };

export function newChatStore(path: string): NewChatStore {
  const file: JsonFile<NewChatFile> = {
    path, label: "New chat settings", initial: () => ({ startSkill: null, lastHost: null }),
    parse: value => {
      const raw = typeof value === "object" && value !== null ? value as { startSkill?: unknown; lastHost?: unknown } : {};
      return { startSkill: parseStartSkill(raw.startSkill ?? null), lastHost: typeof raw.lastHost === "string" && raw.lastHost ? raw.lastHost : null };
    },
  };
  const readFile = () => readJsonFile(file).catch(error => { if (missing(error)) return file.initial(); throw error; });
  return {
    read: async () => ({ startSkill: (await readFile()).startSkill }),
    write: async next => ({ startSkill: (await transactJsonFile(file, state => { state.startSkill = next.startSkill; })).state.startSkill }),
    lastHost: async () => (await readFile()).lastHost,
    setLastHost: async name => { await transactJsonFile(file, state => { state.lastHost = name; }); },
  };
}
