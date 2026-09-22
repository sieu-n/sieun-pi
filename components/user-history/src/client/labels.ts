import { api } from "./api.ts";
import { store } from "./store.svelte.ts";
import type { Priority, SessionRow, Tag } from "../shared/types.ts";

function patchRows(ids: readonly string[], change: (row: SessionRow) => SessionRow): void {
  const selected = new Set(ids);
  store.sessions = store.sessions.map(row => selected.has(row.id) ? change(row) : row);
}

/** Label writes go to the server; the sessions stream then carries the saved result to every tab. Priority and tag toggles also patch the local rows so keys feel instant. */
export const labels = {
  tagMap(): Map<string, Tag> { return new Map(store.tags.map(tag => [tag.id, tag])); },
  async setPriority(ids: readonly string[], priority: Priority): Promise<void> {
    if (!ids.length) return;
    patchRows(ids, row => ({ ...row, priority }));
    await store.run(api.labels({ op: "priority", ids: [...ids], priority }));
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
