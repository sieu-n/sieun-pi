<script lang="ts">
  import Spinner from "./Spinner.svelte";
  import { onMount } from "svelte";
  import { api } from "./api.ts";
  import { clock } from "./clock.svelte.ts";
  import { clockTime, duration } from "./format.ts";
  import type { HostTool, HostToolsCard, SkillInfo, SkillSource, SkillsView, ToolCheck, ToolsDailyRun, ToolsView } from "../shared/types.ts";
  import Icon from "./Icon.svelte";

  const TOOL_LABELS: Record<HostTool, string> = {
    "websearch": "Web search",
    "headless-browser": "Headless browser",
    "aside": "Aside browser",
    "cua-driver": "Computer use",
  };
  const SOURCES: { source: SkillSource; label: string }[] = [
    { source: "global", label: "Global" },
    { source: "built-in", label: "Built in" },
    { source: "repo", label: "Repo" },
  ];
  const VERDICT: Record<ToolsDailyRun["verdict"], { tone: string; text: string }> = {
    met: { tone: "on", text: "every check passed" },
    missed: { tone: "problem", text: "found problems" },
    error: { tone: "problem", text: "did not finish" },
    skipped: { tone: "off", text: "was skipped" },
  };

  let tools = $state<ToolsView | undefined>(undefined);
  let toolsError = $state<string | null>(null);
  let checking = $state(false);
  let checkStarted = $state(0);
  let checkError = $state<string | null>(null);
  let skills = $state<SkillsView | undefined>(undefined);
  let skillsError = $state<string | null>(null);
  let query = $state("");

  const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
  async function loadTools(): Promise<void> {
    toolsError = null;
    try { tools = await api.tools(); }
    catch (reason) { toolsError = message(reason); }
  }
  async function loadSkills(): Promise<void> {
    skillsError = null;
    try { skills = await api.skills(); }
    catch (reason) { skillsError = message(reason); }
  }
  async function checkAgain(): Promise<void> {
    checking = true;
    checkStarted = Date.now();
    checkError = null;
    try { tools = await api.checkTools(); }
    catch (reason) { checkError = message(reason); }
    checking = false;
  }
  onMount(() => { void loadTools(); void loadSkills(); });

  /** "just now", "4 min ago", "3 h ago", "2 d ago". */
  function ago(at: number, now: number): string {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
    return `${Math.floor(minutes / 1440)} d ago`;
  }
  function localTime(at: number): string {
    const date = new Date(at);
    if (date.toDateString() === new Date().toDateString()) return `today at ${clockTime(at)}`;
    return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  const checksOf = (host: HostToolsCard) => host.tools.flatMap(row => row.used ? row.checks : []);
  const allChecks = $derived(tools?.hosts.flatMap(checksOf) ?? []);
  const failing = $derived(allChecks.filter(check => check.status === "fail").length);
  const unreachable = $derived(tools?.hosts.filter(host => host.state === "unreachable").length ?? 0);
  /** One box's line: its failures, or that it did not answer, or that every check it is meant to have passes. */
  function hostLine(host: HostToolsCard): { tone: "on" | "problem"; text: string } {
    if (host.state === "unreachable") return { tone: "problem", text: `Not checked. ${host.error}` };
    const checks = checksOf(host);
    const fails = checks.filter(check => check.status === "fail").length;
    if (!checks.length) return { tone: "on", text: "No tool is set for this host." };
    return fails ? { tone: "problem", text: `${fails} of ${checks.length} checks fail.` } : { tone: "on", text: "Every check passes." };
  }
  const elapsed = $derived(checking ? Math.max(0, Math.round((clock.now - checkStarted) / 1000)) : 0);

  const needle = $derived(query.trim().toLowerCase());
  const matches = (skill: SkillInfo) => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
  const shown = $derived(skills?.skills.filter(matches) ?? []);
  const skillGroups = $derived(SOURCES.map(entry => ({
    ...entry,
    total: skills?.skills.filter(skill => skill.source === entry.source).length ?? 0,
    tokens: skills?.tokens.groups[entry.source] ?? 0,
    skills: shown.filter(skill => skill.source === entry.source).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter(group => group.skills.length));
  const count = (value: number) => value.toLocaleString("en-US");
  /** Why a skill adds no tokens, for the token cell's tooltip. */
  const noTokens = (skill: SkillInfo) => !skill.enabled ? "Off, so Prime leaves it out of the prompt."
    : skill.userOnly ? "disable-model-invocation is set, so only a /skill command loads it and the prompt never lists it."
    : "Prime does not read this folder; it is a Claude Code skill.";
</script>

{#snippet mark(status: ToolCheck["status"])}
  <span class="mark {status}">
    {#if status === "pass"}<Icon name="check" size={12} />{:else if status === "fail"}<Icon name="x" size={12} />{:else}<span class="ring" aria-hidden="true"></span>{/if}
    {status}
  </span>
{/snippet}

<section class="pane" aria-label="Tools and skills">
  <section class="block" aria-label="Tools">
    <div class="block-head">
      <h4>Tools</h4>
      <div class="head-side">
        {#if checking}
          <span class="note">Checking, {elapsed} s. It can take a minute.</span>
        {:else if tools}
          <span class="note" title={new Date(tools.checkedAt).toLocaleString()}>Checked {ago(tools.checkedAt, clock.now)}</span>
        {/if}
        <button class="button small" disabled={checking || (!tools && !toolsError)} onclick={() => void checkAgain()}>
          {#if checking}<Spinner />{:else}<Icon name="refresh" size={13} />{/if}
          Check again
        </button>
      </div>
    </div>
    {#if checkError}<p class="note problem">The check did not finish. {checkError}</p>{/if}
    {#if toolsError && !tools}
      <div class="empty">
        <div class="error"><Icon name="alert" size={16} /> Tool status unavailable. {toolsError}</div>
        <button class="button small" onclick={() => void loadTools()}>Retry</button>
      </div>
    {:else if !tools}
      <div class="empty muted"><Spinner size="normal" /> Running the tool checks</div>
    {:else}
      <p class="current" class:on={failing === 0 && unreachable === 0} class:problem={failing > 0 || unreachable > 0}>
        <span class="dot" aria-hidden="true"></span>
        <span>
          {failing === 0 ? "Every tool check passes" : `${failing} of ${allChecks.length} checks fail`}{unreachable ? `, and ${unreachable} ${unreachable === 1 ? "host" : "hosts"} did not answer` : ""}.
        </span>
      </p>
      {#if tools.registryError}<p class="note problem">The hosts list did not read, so only this box shows. {tools.registryError}</p>{/if}
      {#each tools.hosts as host (host.name)}
        {@const line = hostLine(host)}
        <section class="host" aria-label="Tools on {host.name}">
          <h5>
            <span class="host-name">{host.name}</span>
            {#if host.self}<span class="badge">This box</span>{/if}
            <span class="host-line {line.tone}" title={line.text}>{line.text}</span>
          </h5>
          {#each host.tools as row (row.tool)}
            <div class="group" class:unused={!row.used}>
              <span class="name">{TOOL_LABELS[row.tool]}</span>
              <ul class="rows">
                {#if !row.used}
                  <li class="note unused-note">Not used on this host.</li>
                {:else if host.state === "unreachable"}
                  <li class="note">Not checked, because the host did not answer.</li>
                {:else}
                  {#each row.checks as check (check.id)}
                    <li class="check {check.status}">
                      {@render mark(check.status)}
                      <span class="tool" title={check.tool}>{check.tool}</span>
                      <span class="detail" title={check.detail}>{check.detail}</span>
                      <span class="ms" title="Check id {check.id}">{duration(check.ms)}</span>
                      {#if check.status === "fail" && check.fix}<span class="fix">To fix, {check.fix}</span>{/if}
                    </li>
                  {:else}
                    <li class="note">No check covers this tool.</li>
                  {/each}
                {/if}
              </ul>
            </div>
          {/each}
        </section>
      {/each}
    {/if}
  </section>

  <section class="block" aria-label="Daily check">
    <h4>Daily check</h4>
    {#if toolsError && !tools}
      <p class="note">Unavailable until the tool status loads.</p>
    {:else if !tools}
      <p class="note">Loading</p>
    {:else if !tools.daily}
      <p class="note">No daily Skills and tools check has run yet.</p>
    {:else}
      {@const daily = tools.daily}
      {@const fails = daily.problems.filter(problem => problem.status === "fail")}
      {@const fixed = fails.filter(problem => problem.recheck?.status === "pass")}
      {@const lastFix = Math.max(0, ...fixed.map(problem => problem.recheck!.at))}
      {@const allFixed = fails.length > 0 && fixed.length === fails.length}
      <p class="current {allFixed ? "on" : VERDICT[daily.verdict].tone}">
        <span class="dot" aria-hidden="true"></span>
        <span>
          {daily.name} ran {localTime(daily.at)} ({ago(daily.at, clock.now)}){daily.checksRun !== null ? ` over ${daily.checksRun} checks` : ""}
          {#if allFixed}
            and found {fails.length} {fails.length === 1 ? "failure" : "failures"}, all fixed; the re-check at {clockTime(lastFix)} passed.
          {:else if fixed.length}
            and found {fails.length} failures; {fixed.length} fixed, {fails.length - fixed.length} still failing.
          {:else}
            and {VERDICT[daily.verdict].text}.
          {/if}
        </span>
      </p>
      {#if daily.summary && !allFixed}<p class="note summary" title={daily.summary}>{daily.summary}</p>{/if}
      {#if daily.problems.length}
        <ul class="rows problems">
          {#each daily.problems as problem (problem.id)}
            <li class="problem-row">
              {#if problem.status === "fail" && problem.recheck?.status === "pass"}
                <span class="mark pass"><Icon name="check" size={12} />fixed</span>
              {:else}
                {@render mark(problem.status)}
              {/if}
              <code class="mono id">{problem.id}</code>
              <span class="detail" title={problem.text}>{problem.text}</span>
              {#if problem.recheck}
                <span class="recheck" title={problem.recheck.detail}>Re-checked {clockTime(problem.recheck.at)}: {problem.recheck.status === "pass" ? "passes" : problem.recheck.status === "off" ? "off" : `still fails, ${problem.recheck.detail}`}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section class="block" aria-label="Skills">
    <div class="block-head">
      <h4>Skills{#if skills}<span class="count">{needle ? `${shown.length} of ${skills.skills.length}` : skills.skills.length}</span>{/if}</h4>
      {#if skills?.skills.length}
        <input class="field filter" type="search" placeholder="Filter by name or description" aria-label="Filter skills" bind:value={query} autocomplete="off" spellcheck="false" />
      {/if}
    </div>
    {#if skillsError && !skills}
      <div class="empty">
        <div class="error"><Icon name="alert" size={16} /> The skill list is unavailable. {skillsError}</div>
        <button class="button small" onclick={() => void loadSkills()}>Retry</button>
      </div>
    {:else if !skills}
      <div class="empty muted"><Spinner size="normal" /> Reading the skill folders</div>
    {:else if !skills.skills.length}
      <p class="note">No skills are installed.</p>
    {:else if !skillGroups.length}
      <p class="note">No skill matches "{query.trim()}".</p>
    {:else}
      {@const first = skills.tokens.firstPrompt}
      <p class="note" title="Each skill's <skill> block in Prime's system prompt, counted at {skills.tokens.charsPerToken} chars per token (measured with Anthropic's count_tokens), plus {skills.tokens.header} tokens of fixed lines around the list.">
        Skills add {count(skills.tokens.total)} tokens to every new session{#if first}, {Math.round(skills.tokens.total / first.tokens * 100)}% of the
          {count(first.tokens)} token first prompt of the newest session in the repo ({localTime(first.at)}){/if}.
      </p>
      {#each skillGroups as group (group.source)}
        <div class="source">
          <h5>{group.label}<span class="count">{needle ? `${group.skills.length} of ${group.total}` : group.total}</span><span class="count">{count(group.tokens)} tokens</span></h5>
          <ul class="rows">
            {#each group.skills as skill (skill.path)}
              <li class="skill" class:disabled={!skill.enabled} title={skill.path}>
                <span class="skill-name">{skill.name}</span>
                <span class="detail" title={skill.description}>{skill.description}</span>
                <span class="tokens" class:none={!skill.tokens} title={skill.tokens ? `${count(skill.tokens)} tokens in every session's prompt` : noTokens(skill)}>{count(skill.tokens)}</span>
                <span class="from" title={skill.from}>{#if !skill.enabled}<span class="off-tag">off</span>{/if}{skill.from}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    {/if}
  </section>
</section>

<style>
  .pane { display: flex; flex-direction: column; gap: 22px; padding: 12px 18px 18px; font-size: 13px; }
  .block { display: flex; flex-direction: column; gap: 10px; }
  .block-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 26px; }
  .head-side { display: flex; align-items: center; gap: 10px; }
  h4, h5 { display: flex; align-items: baseline; gap: 6px; margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--text-muted); }
  h5 { position: sticky; top: 0; z-index: 1; padding: 4px 0; font-size: 11.5px; color: var(--text-faint); background: var(--bg-elevated); }
  .count { font-weight: 500; letter-spacing: 0; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .note.problem { color: var(--danger); }
  .current { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .current.on .dot { background: var(--success, #2e9e5b); }
  .current.problem .dot { background: var(--danger); }
  .current.problem { color: var(--danger); }
  .summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .host { display: flex; flex-direction: column; gap: 6px; }
  .host + .host { margin-top: 8px; }
  .host h5 { text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text); }
  .host-name { font-weight: 600; }
  .badge { padding: 1px 6px; border-radius: 999px; background: var(--bg-hover); color: var(--text-muted); font-size: 11.5px; font-weight: 500; }
  .host-line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; color: var(--text-muted); }
  .host-line.problem { color: var(--danger); }
  .group { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 4px 16px; }
  .group.unused .name, .unused-note { color: var(--text-faint); }
  .rows > li.note { padding: 5px 0; }
  .name { font-weight: 500; padding-top: 5px; }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows > li + li { border-top: 1px solid var(--border); }
  .check { display: grid; grid-template-columns: 52px 150px minmax(0, 1fr) max-content; align-items: baseline; gap: 2px 12px; padding: 5px 0; }
  .tool { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .check.fail .detail { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
  .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
  .ms { font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .fix { grid-column: 2 / -1; line-height: 1.45; overflow-wrap: anywhere; }

  .mark { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); }
  .mark.pass :global(svg) { color: var(--success, #2e9e5b); }
  .mark.fail { color: var(--danger); }
  .ring { width: 8px; height: 8px; margin: 0 2px; border-radius: 50%; border: 1.5px solid var(--border-strong); box-sizing: border-box; }

  .problems { margin-left: 16px; }
  .recheck { grid-column: 3; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .problem-row { display: grid; grid-template-columns: 52px max-content minmax(0, 1fr); align-items: baseline; gap: 12px; padding: 4px 0; }
  .id { font-size: 12px; color: var(--text-muted); }

  .filter { width: 240px; padding: 3px 10px; font-size: 12.5px; }
  .source { display: flex; flex-direction: column; }
  .source + .source { margin-top: 8px; }
  .skill { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr) 56px 170px; align-items: baseline; gap: 12px; padding: 4px 0; }
  .tokens { text-align: right; font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .tokens.none { color: var(--text-faint); }
  .skill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-size: 12px; color: var(--text-faint); }
  .off-tag { margin-right: 6px; color: var(--text-muted); font-weight: 500; }
  .skill.disabled .skill-name, .skill.disabled .detail { opacity: 0.55; }

  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
</style>
