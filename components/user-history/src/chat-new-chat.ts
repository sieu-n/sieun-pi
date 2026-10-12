import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { parseStartSkill, type NewChatSettings } from "./shared/start-skill.ts";

/** `<data dir>/new-chat.json`, the New chat box's settings. A missing file reads as no start skill. */
export interface NewChatStore { read(): Promise<NewChatSettings>; write(next: NewChatSettings): Promise<NewChatSettings> }

export function newChatStore(path: string): NewChatStore {
  const file: JsonFile<NewChatSettings> = {
    path, label: "New chat settings", initial: () => ({ startSkill: null }),
    parse: value => ({ startSkill: parseStartSkill(typeof value === "object" && value !== null ? (value as { startSkill?: unknown }).startSkill : null) }),
  };
  return {
    read: () => readJsonFile(file).catch(error => { if (missing(error)) return file.initial(); throw error; }),
    write: async next => (await transactJsonFile(file, state => { state.startSkill = next.startSkill; })).state,
  };
}
