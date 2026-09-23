<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { shortPath } from "./format.ts";
  import { modelShort, PRIORITY_LABEL, PROGRESS_LABEL, STATUS_LABEL, type RowFilter, type RowStatus } from "./organize.ts";
  import { PROGRESS_STEPS, type Priority, type Progress } from "../shared/types.ts";
  import Select, { type SelectOption } from "./ui/Select.svelte";

  /** The label filters the Agents view and the sidebar Filter panel share, each option drawn with its real mark. */
  let { filter, onchange }: { filter: RowFilter; onchange: (patch: Partial<RowFilter>) => void } = $props();

  const STATUSES: readonly RowStatus[] = ["needs", "working", "idle", "saved"];
  const LEVELS: readonly Priority[] = [3, 2, 1, 0];
  const any = (label: string): SelectOption => ({ value: "any", label });
  const modelName = (model: string) => model.slice(model.indexOf("/") + 1);

  const workspaces = $derived([...new Set(store.sessions.map(row => row.cwd))].sort());
  const models = $derived([...new Set(store.sessions.flatMap(row => row.model ? [row.model] : []))].sort());
  const statusOptions: SelectOption[] = [any("Any status"), ...STATUSES.map(status => ({ value: status, label: STATUS_LABEL[status], mark: { kind: "status", status } as const }))];
  const priorityOptions: SelectOption[] = [any("Any priority"), ...LEVELS.map(level => ({ value: String(level), label: PRIORITY_LABEL[level], mark: { kind: "priority", level } as const }))];
  const progressOptions: SelectOption[] = [any("Any progress"), ...PROGRESS_STEPS.map(progress => ({ value: progress, label: PROGRESS_LABEL[progress], mark: { kind: "progress", progress } as const }))];
  const tagOptions = $derived<SelectOption[]>([any("Any tag"), { value: "none", label: "No tags" }, ...store.tags.map(tag => ({ value: tag.id, label: tag.name, mark: { kind: "tag", tag } as const }))]);
  const workspaceOptions = $derived<SelectOption[]>([any("Any workspace"), ...workspaces.map(cwd => ({ value: cwd, label: shortPath(cwd) }))]);
  const modelOptions = $derived<SelectOption[]>([any("Any model"), ...models.map(model => ({ value: model, label: modelName(model), hint: modelShort(model) }))]);
</script>

<Select label="Status" options={statusOptions} value={filter.status} resetValue="any" onchange={value => onchange({ status: value as RowStatus | "any" })} />
<Select label="Tag" options={tagOptions} value={filter.tag} resetValue="any" onchange={value => onchange({ tag: value })} />
<Select label="Priority" options={priorityOptions} value={String(filter.priority)} resetValue="any" onchange={value => onchange({ priority: value === "any" ? "any" : Number(value) as Priority })} />
<Select label="Progress" options={progressOptions} value={filter.progress} resetValue="any" onchange={value => onchange({ progress: value as Progress | "any" })} />
<Select label="Workspace" options={workspaceOptions} value={filter.cwd} resetValue="any" width={300} onchange={value => onchange({ cwd: value })} />
<Select label="Model" options={modelOptions} value={filter.model} resetValue="any" width={280} onchange={value => onchange({ model: value })} />
