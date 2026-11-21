<script lang="ts">
  import { agents, api, requestId, roomOf, type DutyRow } from "$lib/api";
  import { Button, Dialog, Field, Input, Select, TextArea, toast } from "$lib/ui";
  import { conversationHref, router } from "$lib/router.svelte";
  import { scheduleWords, type ScheduleDraft } from "./schedule";

  /**
   * Edit a duty's goal and schedule, or ask the agent for a new duty. A new duty needs a precheck and targets only the agent can write, so
   * the dialog sends his words and the schedule to the agent's DM, and the duty joins this list once the agent adds it.
   */
  type Props = { open: boolean; chatId: string; duty: DutyRow | null; onchange: (duties: DutyRow[]) => void };
  let { open = $bindable(), chatId, duty, onchange }: Props = $props();

  type Repeat = ScheduleDraft["kind"];
  let goal = $state("");
  let repeat = $state<Repeat>("auto");
  let at = $state("07:00");
  let minutes = $state("60");
  let saving = $state(false);

  $effect(() => {
    if (!open) return;
    goal = duty?.duty.goal ?? "";
    const schedule = duty?.schedule;
    repeat = schedule?.kind ?? "auto";
    at = schedule?.kind === "daily" ? schedule.at : "07:00";
    minutes = schedule?.kind === "every" ? String(schedule.minutes) : "60";
  });

  const repeats = $derived([
    ...(duty ? [] : [{ value: "auto" as const, label: "Every morning, time picked for me" }]),
    { value: "daily" as const, label: "Every day at" },
    { value: "every" as const, label: "Every few minutes" },
  ]);
  const draft = $derived<ScheduleDraft>(repeat === "daily" ? { kind: "daily", at } : repeat === "every" ? { kind: "every", minutes: Number(minutes) } : { kind: "auto" });
  const minutesBad = $derived(repeat === "every" && !(Number.isInteger(Number(minutes)) && Number(minutes) >= 1));
  const timeBad = $derived(repeat === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at));
  const dirty = $derived(duty ? goal.trim() !== duty.duty.goal || JSON.stringify(draft) !== JSON.stringify(duty.schedule) : goal.trim() !== "");
  const ready = $derived(goal.trim() !== "" && !minutesBad && !timeBad && dirty);

  async function save() {
    if (!ready || saving) return;
    saving = true;
    try {
      if (duty) await saveEdit(duty);
      else await ask();
      open = false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The duty did not change.");
    } finally {
      saving = false;
    }
  }

  async function saveEdit(row: DutyRow) {
    const id = row.duty.id;
    if (draft.kind !== "auto" && JSON.stringify(draft) !== JSON.stringify(row.schedule)) onchange((await api.dutyAction(chatId, { action: "schedule", duty: id, schedule: draft })).duties);
    if (goal.trim() !== row.duty.goal) onchange((await api.dutyAction(chatId, { action: "goal", duty: id, goal: goal.trim() })).duties);
    toast.success(`Saved ${row.duty.name}`);
  }

  /** The agent whose board this is, by its id or by its work thread's root, so the ask lands in its DM; a root thread no agent holds gets it itself. */
  const agent = $derived(agents.list.find(entry => entry.id === chatId || (entry.thread === chatId && entry.conversation === 1)));

  async function ask() {
    const room = agent ? agents.room(agent.id) : roomOf(chatId);
    await api.send(room, { text: `Please add a duty for this: ${goal.trim()}\n\nRun it ${scheduleWords(draft)}.`, requestId: requestId() });
    toast.success(`Sent to ${agent?.name ?? "the agent"}. The duty shows here once it adds it.`, { action: { label: "Open DM", run: () => router.navigate(conversationHref(room)) }, duration: 8000 });
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  }
</script>

<Dialog bind:open {dirty} width={520} title={duty ? `Edit ${duty.duty.name}` : "New duty"}
  description={duty ? "The agent's next run reads the new goal and runs on the new schedule." : "Say what the agent should check. It writes the check and its targets, then adds the duty here."}>
  <div class="fields" data-duty-dialog>
    <Field label={duty ? "Goal" : "What should it check?"} id="duty-goal" hint={duty ? "What good means, in plain words." : "For example: every channel answers within 5 minutes."}>
      <TextArea id="duty-goal" bind:value={goal} rows={3} maxRows={8} onkeydown={keydown} data-autofocus />
    </Field>
    <div class="schedule">
      <Select label="Repeat" showLabel bind:value={repeat} options={repeats} />
      {#if repeat === "daily"}
        <Input type="time" aria-label="Time of day" bind:value={at} invalid={timeBad} />
      {:else if repeat === "every"}
        <Input type="number" min="1" step="1" aria-label="Minutes between runs" bind:value={minutes} invalid={minutesBad}>
          {#snippet suffix()}<span class="unit t-caption">min</span>{/snippet}
        </Input>
      {/if}
    </div>
  </div>
  {#snippet actions()}
    <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" loading={saving} disabled={!ready} onclick={() => void save()}>{duty ? "Save" : "Send to agent"}</Button>
  {/snippet}
</Dialog>

<style>
  .fields { display: grid; gap: var(--space-4); }
  .schedule { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .schedule :global(.input) { width: 8.5rem; }
  .unit { color: var(--text-subtle); }
</style>
