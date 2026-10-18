/**
 * The curated wiki pages a clean-room chat made, which teardown marks as test output. On 10-18 the archived test chats "Reddit index gaps"
 * and "Bluesky index gaps" left pages that said "measured daily" while nothing measured them, and the IG, YouTube, Facebook, Xiaohongshu,
 * Douyin and TikTok Shop pages from earlier runs read the same way. The wiki API has no delete, and wiki-box-commit carries only new and
 * changed files to sieun/dev, so a page is archived in place through PATCH api/agent/page: status archived hides it from hub lists, and
 * its description says a test chat wrote it. Session logs under sessions/ stay as they are.
 */

export const TEST_DESCRIPTION = "A test chat wrote this page, and that chat is archived now, so nothing measures these numbers again. " +
  "Read every number here as a one-time snapshot from the date next to it.";

export interface WikiChange { path: string; version: number; ts: string }

/** Pages first written (version 1) at or after `since`, outside sessions/, whose path one of the chat's transcripts names. */
export function testPages(changes: readonly WikiChange[], transcripts: readonly string[], since: number): string[] {
  const made = new Set(changes.filter(change => change.version === 1 && Date.parse(change.ts) >= since && !change.path.startsWith("sessions/")).map(change => change.path));
  return [...made].filter(path => transcripts.some(text => text.includes(path))).sort();
}

const field = (front: string, key: string): string | undefined => new RegExp(`"${key}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(front)?.[0];

/** The PATCH edits that archive a page and name it test output; none when a run already did. */
export function archiveEdits(raw: string): { old_string: string; new_string: string }[] {
  const front = /^\s*<!--wiki([\s\S]*?)-->/.exec(raw)?.[1];
  if (!front) return [];
  // The title stays: since 10-18 the wiki refuses a meta title that differs from the page's first <h1> ("a note such as \"test output\" belongs
  // in the description"), and r3g's teardown failed on both its pages that way. The status and the description carry the mark.
  const edits: { old_string: string; new_string: string }[] = [];
  const status = field(front, "status");
  if (status && status !== '"status": "archived"') edits.push({ old_string: status, new_string: '"status": "archived"' });
  const description = field(front, "description");
  if (description && !description.includes(TEST_DESCRIPTION)) edits.push({ old_string: description, new_string: `"description": "${TEST_DESCRIPTION}"` });
  return edits;
}

/** Reads the pages the wiki made since `since`, picks the chat's, and archives each one. Returns the archived paths and the failed ones. */
export async function archiveTestPages(origin: string, transcripts: readonly string[], since: number, fetchImpl: typeof fetch = fetch):
  Promise<{ archived: string[]; failed: string[] }> {
  const listed = await fetchImpl(`${origin}/api/agent/changes?since=${new Date(since).toISOString()}&limit=100000`);
  if (!listed.ok) throw new Error(`wiki changes: ${listed.status}`);
  const { changes } = await listed.json() as { changes: WikiChange[] };
  const archived: string[] = [], failed: string[] = [];
  for (const path of testPages(changes, transcripts, since)) {
    const raw = await fetchImpl(`${origin}/raw/${path}`);
    const edits = raw.ok ? archiveEdits(await raw.text()) : [];
    if (!raw.ok) { if (raw.status !== 404) failed.push(path); continue; }
    if (!edits.length) continue;
    const patch = (list: typeof edits) => fetchImpl(`${origin}/api/agent/page`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, edits: list, author: "clean-room teardown", summary: "A test chat wrote this page; archived at teardown" }) });
    let patched = await patch(edits);
    // A page a hub links keeps its status (the wiki answers 409 until the hub drops the link, and the hub is not the test's to edit); its
    // description still says a test chat wrote it. r3g's LinkedIn and Facebook field pages were linked from their platform hubs on 10-18.
    const described = edits.filter(edit => !edit.new_string.startsWith('"status"'));
    if (patched.status === 409 && described.length < edits.length) {
      if (!described.length) { archived.push(path); continue; }
      patched = await patch(described);
    }
    (patched.ok ? archived : failed).push(path);
  }
  return { archived, failed };
}
