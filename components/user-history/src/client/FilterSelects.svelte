<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { shortPath } from "./format.ts";
  import { machinesOf, modelShort, PRIORITY_LABEL, STATUS_LABEL, type RowFilter, type RowStatus } from "./organize.ts";
  import type { Priority } from "../shared/types.ts";
  import Select, { type SelectOption } from "./ui/Select.svelte";

  /** The label filters the Agents view and the sidebar Filter panel share, each option drawn with its real mark. The sidebar sets the machine outside the panel. */
  let { filter, onchange, machine = true }: { filter: RowFilter; onchange: (patch: Partial<RowFilter>) => void; machine?: boolean } = $props();

  const STATUSES: readonly RowStatus[] = ["needs", "working", "stalled", "idle", "saved"];
  const LEVELS: readonly Priority[] = [3, 2, 1, 0];
  const any = (label: string): SelectOption => ({ value: "any", label });
  const modelName = (model: string) => model.slice(model.indexOf("/") + 1);

  const workspaces = $derived([...new Set(store.sessions.map(row => row.cwd))].sort());
  const models = $derived([...new Set(store.sessions.flatMap(row => row.model ? [row.model] : []))].sort());
  const machines = $derived(machinesOf(store.sessions));
  const statusOptions: SelectOption[] = [any("Any status"), ...STATUSES.map(status => ({ value: status, label: STATUS_LABEL[status], mark: status === "stalled" ? { kind: "status", status, level: "stalled" } as const : { kind: "status", status } as const }))];
  const priorityOptions: SelectOption[] = [any("Any priority"), ...LEVELS.map(level => ({ value: String(level), label: PRIORITY_LABEL[level], mark: { kind: "priority", level } as const }))];
  const tagOptions = $derived<SelectOption[]>([any("Any tag"), { value: "none", label: "No tags" }, ...store.tags.map(tag => ({ value: tag.id, label: tag.name, mark: { kind: "tag", tag } as const }))]);
  const workspaceOptions = $derived<SelectOption[]>([any("Any workspace"), ...workspaces.map(cwd => ({ value: cwd, label: shortPath(cwd) }))]);
  const modelOptions = $derived<SelectOption[]>([any("Any model"), ...models.map(model => ({ value: model, label: modelName(model), hint: modelShort(model) }))]);
  const machineOptions = $derived<SelectOption[]>([any("Any machine"), ...machines.map(host => ({ value: host, label: host }))]);
</script>

<Select label="Status" options={statusOptions} value={filter.status} resetValue="any" onchange={value => onchange({ status: value as RowStatus | "any" })} />
<Select label="Tag" options={tagOptions} value={filter.tag} resetValue="any" onchange={value => onchange({ tag: value })} />
<Select label="Priority" options={priorityOptions} value={String(filter.priority)} resetValue="any" onchange={value => onchange({ priority: value === "any" ? "any" : Number(value) as Priority })} />
<Select label="Workspace" options={workspaceOptions} value={filter.cwd} resetValue="any" width={300} onchange={value => onchange({ cwd: value })} />
<Select label="Model" options={modelOptions} value={filter.model} resetValue="any" width={280} onchange={value => onchange({ model: value })} />
{#if machine && machines.length > 1}<Select label="Machine" options={machineOptions} value={filter.host} resetValue="any" onchange={value => onchange({ host: value })} />{/if}
