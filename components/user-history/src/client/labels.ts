import { api } from "./api.ts";
import { store } from "./store.svelte.ts";
import { ui } from "./ui.svelte.ts";
import type { Priority, Progress, SessionRow, Tag } from "../shared/types.ts";

function patchRows(ids: readonly string[], change: (row: SessionRow) => SessionRow): void {
  const selected = new Set(ids);
  store.sessions = store.sessions.map(row => selected.has(row.id) ? change(row) : row);
}

export type Coverage = "all" | "some" | "none";
/** What a tag picker edits: the tags of some threads, or a draft list before a thread exists. */
export interface TagSelection { label: string; coverage: (tag: Tag) => Coverage; set: (tagId: string, on: boolean) => Promise<void>; create: (name: string) => Promise<void> }

/** Label writes go to the server; the sessions stream then carries the saved result to every tab. Priority and tag toggles also patch the local rows so keys feel instant. */
export const labels = {
  tagMap(): Map<string, Tag> { return new Map(store.tags.map(tag => [tag.id, tag])); },
  async setPriority(ids: readonly string[], priority: Priority): Promise<void> {
    if (!ids.length) return;
    patchRows(ids, row => ({ ...row, priority }));
    await store.run(api.labels({ op: "priority", ids: [...ids], priority }));
  },
  async setProgress(ids: readonly string[], progress: Progress): Promise<void> {
    if (!ids.length) return;
    patchRows(ids, row => ({ ...row, progress }));
    await store.run(api.labels({ op: "progress", ids: [...ids], progress }));
  },
  /**
   * One click, like Ctrl+X in the terminal agents view: the rows leave the list at once, an open one hands the view to the next thread in the
   * sidebar (or New chat), and a toast offers Undo, which records the thread as active again.
   */
  async archive(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const gone = new Set(ids);
    if (store.selectedId && gone.has(store.selectedId)) {
      const order = ui.sidebarOrder;
      const at = order.indexOf(store.selectedId);
      const next = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at)).reverse()].find(id => !gone.has(id)) ?? null;
      store.select(next);
    }
    patchRows(ids, row => ({ ...row, archived: true, kind: "saved", status: "saved" }));
    const results = await Promise.all(ids.map(id => store.run(api.archive(id))));
    const done = ids.filter((_, index) => results[index] !== undefined);
    if (!done.length) return;
    store.toast(done.length === 1 ? "Archived" : `Archived ${done.length} threads`, "info", { label: "Undo", run: () => void labels.unarchive(done) });
  },
  async unarchive(ids: readonly string[]): Promise<void> {
    patchRows(ids, row => ({ ...row, archived: false }));
    await Promise.all(ids.map(id => store.run(api.unarchive(id))));
  },
  async setTag(ids: readonly string[], tagId: string, on: boolean): Promise<void> {
    if (!ids.length) return;
    patchRows(ids, row => ({ ...row, tags: on ? (row.tags.includes(tagId) ? row.tags : [...row.tags, tagId]) : row.tags.filter(tag => tag !== tagId) }));
    await store.run(api.labels({ op: "tag", tagId, ids: [...ids], on }));
  },
  async create(name: string, ids: readonly string[]): Promise<string | undefined> {
    return (await store.run(api.labels({ op: "create", name, ids: [...ids] })))?.tagId;
  },
  async rename(tagId: string, name: string): Promise<void> { await store.run(api.labels({ op: "rename", tagId, name })); },
  async remove(tagId: string): Promise<void> { await store.run(api.labels({ op: "delete", tagId })); },
};

export function threadTags(ids: readonly string[]): TagSelection {
  return {
    label: ids.length > 1 ? `Tags for ${ids.length} threads` : "Tags",
    coverage(tag) {
      const rows = store.sessions.filter(row => ids.includes(row.id));
      const count = rows.filter(row => row.tags.includes(tag.id)).length;
      return count === 0 ? "none" : count === rows.length ? "all" : "some";
    },
    set: (tagId, on) => labels.setTag(ids, tagId, on),
    async create(name) { await labels.create(name, ids); },
  };
}
