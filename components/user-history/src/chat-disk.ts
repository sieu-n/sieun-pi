import type { ArtifactDisk } from "./checkin-load.ts";
import { type Host, listHostDir, readHostFile } from "./hosts.ts";

/*
 * A chat's Prime artifacts on the box that runs it, for the check-in on us-metal02 (src/checkin-load.ts `parkSchedules`). Its own module, so
 * the check-in's code reaches the relay client only through the service that wires it (chat-backend.ts).
 */

export const hostDisk = (host: Host, home: string): ArtifactDisk => ({ home,
  list: dir => listHostDir(host, dir).then(entries => entries.map(entry => entry.name), () => []),
  read: file => readHostFile(host, file).then(found => found.bytes.toString("utf8"), () => null) });
/** The home a session file on a box lives under, from its path on that box (`/Users/sieunpark/.prime/agent/sessions/<id>.jsonl`). */
export const homeOfSessionFile = (path: string): string | undefined => /^(.*?)\/\.prime\/agent\//.exec(path)?.[1];

/** What `chatDisk` reads of the catalog: which box runs a session, that box's hosts.json entry, the other boxes' rows, and a row's path there. */
export interface DiskCatalog {
  hostOf(id: string): string | null;
  hostEntry(name: string): Host | undefined;
  remoteRows(): readonly { sessionId: string; sessionFile?: string }[];
  daemonPath(summary: { sessionId: string; sessionFile?: string }): string | undefined;
}
/**
 * The disk of the box that runs chat `id`: null for this box's chats and when the other box's home cannot be told from the chat's row. The row
 * comes from that box's list, so no copy of the chat's transcript is made for it.
 */
export async function chatDisk(catalog: DiskCatalog, id: string): Promise<ArtifactDisk | null> {
  const name = catalog.hostOf(id);
  const host = name ? catalog.hostEntry(name) : undefined;
  if (!host) return null;
  const row = catalog.remoteRows().find(entry => entry.sessionId === id);
  const home = row ? homeOfSessionFile(catalog.daemonPath(row) ?? "") : undefined;
  return home ? hostDisk(host, home) : null;
}
