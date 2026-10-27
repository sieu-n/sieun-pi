/**
 * The New chat box's start skill: a skill the first message of every new thread or chat starts with, set in Settings > New chats and kept in
 * `<data dir>/new-chat.json`. Unset on a fresh install, so the box offers no skill checkbox until its owner picks one.
 */
export interface NewChatSettings { startSkill: string | null }

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A stored or posted start skill: null or a skill name (`poteto-mode`, not `/skill:poteto-mode`). Anything else throws. */
export function parseStartSkill(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !SKILL_NAME.test(value)) throw new Error("Use a skill name such as my-skill, or null for none.");
  return value;
}

/** The first message as sent: `/skill:<skill> <text>` while the checkbox is on, except a message that already starts with a command. */
export function startMessage(text: string, skill: string | null): string {
  return skill && !text.trimStart().startsWith("/") ? `/skill:${skill} ${text}` : text;
}
