import type { OwnerTodo } from "./types.ts";

/**
 * A step whose job runs on a box that reads offline while an open For you todo asks the owner to bring that box back waits on his answer, as a
 * step a For you todo links does. From about 10:10Z on 10-23 the owner's MacBook Pro slept off Tailscale, the chat service's copy of its
 * session list stayed at its 09:47Z full list (last activity 09:52Z), and every job of sep launch!! and Railway Breach on it read ended: the
 * check-in counted 39 and 2 stuck steps and d9 read stuck_steps_all 44 at 12:27Z, though no job could start or steer them until the owner woke
 * the Mac, which For you t96 asked of him at 13:36Z. Once the box reads online again its steps count by their jobs again.
 */
export interface HostHold {
  /** The box's hosts.json name. */
  host: string;
  /** The open todo that asks the owner to bring it back, and the chat whose board holds it. */
  todo: string; chat?: string;
  /** When Tailscale last saw the box. */
  lastSeen?: string;
}

/** A box that reads offline now, by its hosts.json name and machine hostname, with when Tailscale last saw it. */
export interface AwayHost { name: string; hostname?: string; lastSeen?: string }

/** What a todo says to bring a box back: wake it, reconnect it, turn or power it on, bring it back online, Tailscale. */
const BACK = /\b(?:wake|reconnect|back online|tailscale|(?:turn|power|switch)\b[^.]{0,30}?\bon|bring\b[^.]{0,30}?\bback)\b/i;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The words that name a box: its hosts.json name, and each tail of two or more of its hostname's words, so "Sieuns-MacBook-Pro" reads in
 * "your MacBook Pro" and "mac" in "the other Mac chats".
 */
export function hostNames(host: Pick<AwayHost, "name" | "hostname">): RegExp {
  const words = (host.hostname ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const tails = words.length >= 2 ? words.slice(0, -1).map((_, index) => words.slice(index)).filter(tail => tail.length >= 2) : [];
  const names = [host.name.split(/[^A-Za-z0-9]+/).filter(Boolean), ...tails].filter(name => name.length);
  return new RegExp(`\\b(?:${names.map(name => name.map(escape).join("[\\s_-]+")).join("|")})\\b`, "i");
}

/** Whether a todo's text asks the owner to bring the box back: it names the box (`hostNames`) and says to wake, reconnect or turn it on. */
export const asksHostBack = (text: string, host: Pick<AwayHost, "name" | "hostname">): boolean => hostNames(host).test(text) && BACK.test(text);

/** Each offline box with the first open For you todo, on any of the owner's boards, that asks him to bring it back (`asksHostBack`). */
export function hostHolds(away: readonly AwayHost[], todos: readonly { chat?: string; todo: Pick<OwnerTodo, "id" | "text" | "done"> }[]): Map<string, HostHold> {
  const holds = new Map<string, HostHold>();
  for (const host of away) {
    const ask = todos.find(entry => !entry.todo.done && asksHostBack(entry.todo.text, host));
    if (ask) holds.set(host.name, { host: host.name, todo: ask.todo.id, ...ask.chat ? { chat: ask.chat } : {}, ...host.lastSeen ? { lastSeen: host.lastSeen } : {} });
  }
  return holds;
}

/** "mac, offline on Tailscale since 10:09Z, which For you t96 asks the owner to bring back". */
export const holdWords = (hold: HostHold): string =>
  `${hold.host}, offline on Tailscale${hold.lastSeen && Number.isFinite(Date.parse(hold.lastSeen)) ? ` since ${new Date(hold.lastSeen).toISOString().slice(11, 16)}Z` : ""}, ` +
  `which For you ${hold.todo} asks the owner to bring back`;
