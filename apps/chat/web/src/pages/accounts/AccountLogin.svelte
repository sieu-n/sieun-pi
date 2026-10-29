<script lang="ts">
  import type { AccountLogin } from "$lib/api/shared/types.ts";
  import { Button, Icon, IconButton, Input, Spinner, toast } from "$lib/ui";
  import { accountsApi } from "./api";
  import { PROVIDER_LABEL } from "./model";

  /**
   * One running or just-ended `pi-pool login`: the sign-in link, the Codex device code, the Claude paste box and the result.
   * `account` is the label of the account that signs in again; `login.account` is its id.
   */
  let { login, account, onchange, onclose, onretry }: {
    login: AccountLogin;
    account?: string | undefined;
    /** The login as the server answered a paste or a cancel, so the card moves on before the next poll. */
    onchange: (login: AccountLogin) => void;
    onclose: () => void;
    onretry: () => void;
  } = $props();

  let code = $state("");
  let sending = $state(false);
  let pasteError = $state<string | null>(null);
  let copied = $state(false);
  const label = $derived(PROVIDER_LABEL[login.provider]);
  const title = $derived(login.account ? `Sign in again as ${account ?? login.account}` : `Add a ${label} account`);
  const running = $derived(login.status === "starting" || login.status === "waiting" || login.status === "finishing");
  const message = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!code.trim() || sending) return;
    sending = true;
    pasteError = null;
    try {
      onchange(await accountsApi.pasteLogin(login.id, code.trim()));
      code = "";
    } catch (caught) {
      pasteError = message(caught);
    } finally {
      sending = false;
    }
  }
  async function cancel(): Promise<void> {
    try {
      onchange(await accountsApi.cancelLogin(login.id));
    } catch (caught) {
      toast.error(message(caught));
    }
  }
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (caught) {
      toast.error(`Could not copy the code. ${message(caught)}`);
      return;
    }
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<section class="login" aria-label={title} aria-live="polite" data-testid="account-login" data-status={login.status}>
  <header>
    <h3>{title}</h3>
    {#if running}
      <Button size="sm" variant="outline" onclick={() => void cancel()}>Cancel</Button>
    {:else}
      <IconButton icon="close" label="Close" size="sm" onclick={onclose} />
    {/if}
  </header>

  {#if login.status === "starting"}
    {#if login.message}<p class="warn"><Icon name="warning" size={16} />{login.message}</p>{/if}
    <p class="state"><Spinner size={14} />{login.message ? "Waiting for a new sign-in link" : `Starting the ${label} sign-in`}</p>
  {:else if login.status === "waiting" || login.status === "finishing"}
    {#if pasteError || login.message}<p class="warn" role="alert"><Icon name="warning" size={16} />{pasteError ?? login.message}</p>{/if}
    <ol class="steps">
      <li>
        <span class="step">1</span>
        <span class="what">Open the sign-in page{login.code ? "." : " and approve."}</span>
        {#if login.url}<Button size="sm" variant="primary" icon="external" href={login.url} target="_blank">Open sign-in page</Button>{/if}
      </li>
      {#if login.code}
        <li>
          <span class="step">2</span>
          <span class="what">Enter this code.</span>
          <span class="code">{login.code}</span>
          <IconButton icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy code"} size="sm" onclick={() => login.code && void copy(login.code)} />
        </li>
      {:else if login.paste}
        <li>
          <span class="step">2</span>
          <span class="what">After you approve, paste the full callback URL from the address bar, or the code the page shows.</span>
          <form class="paste" onsubmit={submit}>
            <Input bind:value={code} size="sm" placeholder="Callback URL or sign-in code" aria-label="Callback URL or sign-in code" autocomplete="off" spellcheck="false" disabled={login.status === "finishing"} />
            <Button type="submit" size="sm" variant="primary" loading={sending} disabled={!code.trim() || login.status === "finishing"}>Submit</Button>
          </form>
        </li>
      {/if}
    </ol>
    <p class="state"><Spinner size={14} />{login.status === "finishing" ? "Checking the URL or code" : "Waiting for you to finish in the browser"}</p>
  {:else if login.status === "done"}
    <p class="state ok"><Icon name="check" size={16} />Signed in. {login.message ?? ""}</p>
    <div class="actions"><Button size="sm" variant="outline" onclick={onclose}>Done</Button></div>
  {:else if login.status === "failed"}
    <p class="state bad"><Icon name="warning" size={16} />The sign-in failed. {login.message ?? ""}</p>
    <div class="actions">
      <Button size="sm" variant="outline" onclick={onclose}>Close</Button>
      <Button size="sm" variant="primary" onclick={onretry}>Try again</Button>
    </div>
  {:else}
    <p class="state">Sign-in cancelled.</p>
  {/if}
</section>

<style>
  .login { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-container); background: var(--surface-inset); }
  header { display: flex; align-items: center; gap: var(--space-2); min-height: 28px; }
  h3 { flex: 1; margin: 0; overflow: hidden; color: var(--text-standard); font: var(--text-label-sm); text-overflow: ellipsis; white-space: nowrap; }
  .steps { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
  .steps li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); min-height: 32px; }
  .step {
    display: inline-flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px; border-radius: 50%;
    background: var(--affordance-subtle); color: var(--text-subtle); font: 500 11px/1 var(--font-sans);
  }
  .what { color: var(--text-subtle); font: var(--text-body-sm); }
  .code { padding: var(--space-1) var(--space-3); border-radius: var(--radius-chip); background: var(--surface-panel); font: 500 16px/1.2 var(--font-mono); letter-spacing: 0.08em; user-select: all; }
  .paste { display: flex; flex: 1 1 260px; gap: var(--space-2); min-width: 0; }
  .paste :global(.input), .paste :global(input) { flex: 1; min-width: 0; }
  .state { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-subtle); font: var(--text-body-sm); }
  .state.ok { color: var(--status-online-border); }
  .state.bad { color: var(--border-danger); overflow-wrap: anywhere; }
  .warn { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-standard); font: var(--text-body-sm); }
  .actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
