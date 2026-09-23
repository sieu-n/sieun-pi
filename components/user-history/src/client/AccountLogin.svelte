<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { PROVIDER_LABEL } from "./accounts.ts";
  import type { AccountLogin } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /** One running or just-ended `pi-pool login`: the sign-in link, the Codex device code, the Claude paste box and the result. */
  let { login, onclose, onretry }: { login: AccountLogin; onclose: () => void; onretry: () => void } = $props();

  let code = $state("");
  let sending = $state(false);
  let copied = $state(false);
  const label = $derived(PROVIDER_LABEL[login.provider]);
  const title = $derived(login.account ? `Sign in again as ${login.account}` : `Add a ${label} account`);
  const running = $derived(login.status === "starting" || login.status === "waiting" || login.status === "finishing");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!code.trim() || sending) return;
    sending = true;
    try { await api.pasteLogin(login.id, code.trim()); code = ""; }
    catch (caught) { store.toast(caught instanceof Error ? caught.message : String(caught)); }
    finally { sending = false; }
  }
  async function cancel(): Promise<void> {
    try { await api.cancelLogin(login.id); }
    catch (caught) { store.toast(caught instanceof Error ? caught.message : String(caught)); }
  }
  async function copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => { copied = false; }, 1500);
  }
</script>

<section class="login card fade-in" aria-label={title} aria-live="polite">
  <header>
    <h3>{title}</h3>
    {#if running}
      <button type="button" class="button small" onclick={() => void cancel()}>Cancel</button>
    {:else}
      <button type="button" class="icon-button small" aria-label="Close" onclick={onclose}><Icon name="x" size={14} /></button>
    {/if}
  </header>

  {#if login.status === "starting"}
    {#if login.message}<p class="warn"><Icon name="alert" size={14} />{login.message}</p>{/if}
    <p class="state"><span class="spinner tiny"></span>{login.message ? "Waiting for a new sign-in link" : `Starting the ${label} sign-in`}</p>
  {:else if login.status === "waiting" || login.status === "finishing"}
    <ol class="steps">
      <li>
        <span class="step">1</span>
        <span class="what">Open the sign-in page{login.code ? "." : " and approve."}</span>
        {#if login.url}<a class="button small" href={login.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a>{/if}
      </li>
      {#if login.code}
        <li>
          <span class="step">2</span>
          <span class="what">Enter this code.</span>
          <span class="code mono">{login.code}</span>
          <button type="button" class="icon-button small" aria-label="Copy code" use:tooltip={copied ? "Copied" : "Copy code"} onclick={() => login.code && void copy(login.code)}>
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
        </li>
      {:else if login.paste}
        <li>
          <span class="step">2</span>
          <span class="what">If the page shows a code, paste it here.</span>
          <form class="paste" onsubmit={submit}>
            <input class="field mono" bind:value={code} placeholder="Sign-in code" aria-label="Sign-in code" autocomplete="off" spellcheck="false" disabled={login.status === "finishing"} />
            <button type="submit" class="button small primary" disabled={!code.trim() || sending || login.status === "finishing"}>Submit</button>
          </form>
        </li>
      {/if}
    </ol>
    <p class="state"><span class="spinner tiny"></span>{login.status === "finishing" ? "Checking the code" : "Waiting for you to finish in the browser"}</p>
  {:else if login.status === "done"}
    <p class="state ok"><Icon name="check" size={14} />Signed in. {login.message ?? ""}</p>
    <div class="actions"><button type="button" class="button small" onclick={onclose}>Done</button></div>
  {:else if login.status === "failed"}
    <p class="state bad"><Icon name="alert" size={14} />The sign-in failed. {login.message ?? ""}</p>
    <div class="actions">
      <button type="button" class="button small" onclick={onclose}>Close</button>
      <button type="button" class="button small primary" onclick={onretry}>Try again</button>
    </div>
  {:else}
    <p class="state muted">Sign-in cancelled.</p>
  {/if}
</section>

<style>
  .login { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; }
  header { display: flex; align-items: center; gap: 8px; min-height: 26px; }
  h3 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .steps li { display: flex; align-items: center; gap: 10px; min-height: 28px; flex-wrap: wrap; }
  .step { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex: none; border-radius: 50%; background: var(--bg-sunken); font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  .what { color: var(--text-muted); }
  .code { padding: 3px 10px; border-radius: var(--radius-small); background: var(--bg-sunken); font-size: 16px; font-weight: 600; letter-spacing: 0.08em; user-select: all; }
  .paste { display: flex; gap: 6px; flex: 1 1 260px; min-width: 0; }
  .paste .field { flex: 1; min-width: 0; height: 26px; padding: 0 8px; font-size: 12.5px; }
  .state { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; color: var(--text-muted); line-height: 1.4; }
  .state.ok { color: var(--success); }
  .state.bad { color: var(--danger); overflow-wrap: anywhere; }
  .warn { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; color: var(--warning); }
  .state :global(svg), .warn :global(svg) { flex: none; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
</style>
