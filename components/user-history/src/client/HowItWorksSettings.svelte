<script lang="ts">
  import { diagrams } from "./diagrams.ts";
  import { onMount } from "svelte";
  import { loadAccounts } from "./accounts.ts";
  import { ACCOUNT_ORDER, formatQuantity, howTopics, settingText, type Topic } from "./how-it-works.ts";
  import type { PoolConfig } from "../shared/types.ts";

  /**
   * Settings > How it works: how chats and the account pool behave, each rule with the value the code uses now. Read-only for now; a rule that
   * becomes a setting gets its control where its value chip is.
   */
  let current = $state<Topic["id"]>("chats");
  /** This Mac's `pi-pool config`, from the accounts view; pi-pool's defaults until it loads or when it cannot be read. */
  let poolConfig = $state<PoolConfig | null>(null);
  const topics = $derived(howTopics(poolConfig));
  const topic = $derived(topics.find(entry => entry.id === current) ?? topics[0]!);
  onMount(() => { loadAccounts(null).then(view => { poolConfig = view.poolConfig; }, () => {}); });
  const fileName = (file: string): string => file.split("/").pop() ?? file;
</script>

<section class="how" aria-label="How it works" use:diagrams={{ html: current, live: false, eager: true }}>

  <div class="segmented topics" role="tablist" aria-label="Topic">
    {#each topics as entry (entry.id)}
      <button role="tab" aria-selected={entry.id === current} class:on={entry.id === current} onclick={() => { current = entry.id; }}>{entry.label}</button>
    {/each}
  </div>

  {#key topic.id}
    <p class="intro">{topic.intro}</p>

    <figure class="diagram-block">
      <div class="diagram-slot"></div>
      <pre><code>{topic.diagram}</code></pre>
    </figure>

    {#if topic.id === "order"}
      <table class="order">
        <thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Set by</th><th scope="col">What it does</th></tr></thead>
        <tbody>
          {#each ACCOUNT_ORDER as row (row.rank)}
            <tr><td class="rank">{row.rank}</td><td class="name">{row.name}</td><td>{row.setBy}</td><td>{row.rule}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <ol class="steps">
      {#each topic.steps as step (step.title)}
        <li><span class="step-title">{step.title}</span><span class="step-text">{step.text}</span></li>
      {/each}
    </ol>

    {#if topic.rules.length}
      <h4>Current values</h4>
      <ul class="rules">
        {#each topic.rules as rule (rule.id)}
          <li class="rule">
            <div class="rule-main">
              <span class="rule-title">{rule.title}</span>
              <span class="rule-text">{rule.text}</span>
              <span class="source" title={rule.source.file}>{fileName(rule.source.file)} · {rule.source.symbol}</span>
            </div>
            <div class="rule-value">
              <span class="value">{formatQuantity(rule.value)}</span>
              <span class="setting">{settingText(rule)}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/key}
</section>

<style>
  .how { display: flex; flex-direction: column; gap: 12px; padding: 12px 18px 18px; font-size: 13px; line-height: 1.45; }
  h4 { margin: 6px 0 0; font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .topics { justify-self: start; align-self: flex-start; }
  .intro { margin: 0; color: var(--text); }
  .diagram-block { margin: 0; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); min-height: 60px; }
  .diagram-block pre { margin: 0; font-family: var(--mono); font-size: 11.5px; color: var(--text-muted); white-space: pre-wrap; }
  .diagram-slot { height: 0; overflow: hidden; }
  .how :global(.diagram-ready .diagram-slot) { height: auto; overflow: visible; }
  .how :global(.diagram-ready pre) { display: none; }
  .how :global(.diagram-frame) { display: block; width: 100%; height: 0; border: 0; background: transparent; }
  .how :global(.diagram-failed .diagram-frame) { display: none; }
  .how :global(.diagram-error) { font-size: 12px; color: var(--warning); }
  .steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
  .steps li::marker { color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .step-title { font-weight: 600; margin-right: 6px; }
  .step-text { color: var(--text-muted); }
  .rules { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .rule { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 14px; padding: 9px 12px; }
  .rule + .rule { border-top: 1px solid var(--border); }
  .rule-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .rule-title { font-weight: 500; }
  .rule-text { color: var(--text-muted); }
  .source { font-family: var(--mono); font-size: 11px; color: var(--text-faint); overflow-wrap: anywhere; }
  .rule-value { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; text-align: right; }
  .value { padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-bold); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .setting { font-size: 11.5px; color: var(--text-faint); overflow-wrap: anywhere; }
  .order { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: var(--radius); font-size: 12.5px; }
  .order th { text-align: left; font-weight: 600; color: var(--text-muted); background: var(--bg-sunken); padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .order td { padding: 7px 10px; vertical-align: top; border-top: 1px solid var(--border); color: var(--text-muted); }
  .order .rank { font-variant-numeric: tabular-nums; color: var(--text-faint); width: 20px; }
  .order .name { color: var(--text); font-weight: 500; white-space: nowrap; }
</style>
