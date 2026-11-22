/**
 * Refuses a spec run whose chat server is the live service, because a spec there writes into the owner's real rooms: on 11-20 a
 * solo.spec.ts run with CHAT_SERVER_URL on :5184 made three real Solo rooms with ag_vent and woke vent three times.
 */

const LIVE_PORT = 5184;
const LIVE_HOSTS = [/\.tail0c093d\.ts\.net$/, /^us-metal02(-dev)?$/];
const FIX = "run the specs on the fixture, for example CHAT_SERVER_URL=http://127.0.0.1:5186 (the default)";

/** Why a server URL is refused, or undefined when it can be a spec server. */
export function liveRefusal(url: string): string | undefined {
  const { hostname, port } = new URL(url);
  if (Number(port) === LIVE_PORT) return `${url} is the live chat on :${LIVE_PORT}; ${FIX}.`;
  if (LIVE_HOSTS.some(h => h.test(hostname))) return `${url} is the live box's name; ${FIX}.`;
  return undefined;
}

/** Why the server behind a URL is refused: a reused vite or server that answers as the live chat, not a fixture. */
export async function servedRefusal(url: string): Promise<string | undefined> {
  const me = (await (await fetch(new URL("/api/me", url))).json()) as { fixture?: boolean };
  return me.fixture === true ? undefined : `${url} serves a chat that is not a fixture (/api/me fixture is ${me.fixture}); ${FIX}.`;
}
