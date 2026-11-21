<script lang="ts">
  import { Button, CardGroup, Menu, Page, PanelHeader, Select, Switch, type MenuEntry } from "$lib/ui";
  import { notificationsPaused, notifyPermission, notifyPrefs, pauseNotifications, setNotifyPrefs, type NotifyLevel } from "$lib/notify-prefs.svelte";
  import { askNotifyPermission, readNotifyPermission } from "$lib/remind-notify";
  import { whenLabel } from "$lib/remind";
  import { inDesktopShell } from "$lib/shell/desktop";
  import SettingRow from "$pages/settings/SettingRow.svelte";
  import { pausePresets } from "./pause";

  /**
   * Notifications: this device's setting in lib/notify-prefs.svelte.ts, the one store lib/notices.svelte.ts reads and the profile menu's
   * pause writes. Which posts notify, a pause with Resume, and the unread count on the Dock icon and in the window title.
   */
  const LEVELS: { value: NotifyLevel; label: string }[] = [
    { value: "all", label: "All new messages" },
    { value: "direct", label: "DMs, mentions and replies" },
    { value: "off", label: "Nothing" },
  ];

  let now = $state(Date.now());
  $effect(() => {
    void readNotifyPermission();
    const timer = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(timer);
  });
  const paused = $derived(notificationsPaused(now));

  /** Why a notification would not show though the setting asks for one, in a few words; null when nothing blocks it. */
  const blocked = $derived.by((): string | null => {
    if (notifyPrefs.level === "off") return null;
    const where = inDesktopShell ? "macOS" : "this browser";
    switch (notifyPermission.value) {
      case "denied": return `Blocked in ${where}'s settings`;
      case "default": return `Not allowed in ${where} yet`;
      case "unsupported": return inDesktopShell ? "This app version can't notify" : "This browser can't notify";
      default: return null;
    }
  });

  let pauseAnchor = $state<HTMLElement>();
  let pauseOpen = $state(false);
  const pauseItems: MenuEntry[] = $derived(
    pausePresets(now).map(p => ({ id: p.id, label: p.label, detail: whenLabel(p.until, now), onselect: () => pauseNotifications(p.until) })),
  );
</script>

<Page measure="narrow">
  {#snippet header()}
    <PanelHeader title="Notifications" icon="bell" level={1} />
  {/snippet}

  <CardGroup>
    <SettingRow label="Notify me about" for="notify-level" detail={blocked ?? undefined}>
      {#if blocked && notifyPermission.value === "default"}<Button variant="outline" size="sm" onclick={() => void askNotifyPermission()}>Allow</Button>{/if}
      <Select id="notify-level" label="Notify me about" size="sm" value={notifyPrefs.level} options={LEVELS} onchange={(level) => setNotifyPrefs({ level })} />
    </SettingRow>
    <SettingRow label="Pause notifications" detail={paused && notifyPrefs.pausedUntil ? `Paused until ${whenLabel(notifyPrefs.pausedUntil, now)}` : undefined}>
      {#if paused}
        <Button variant="outline" size="sm" onclick={() => pauseNotifications(null)}>Resume</Button>
      {:else}
        <Button variant="outline" size="sm" trailingIcon="chevron-down" bind:element={pauseAnchor} onclick={() => (pauseOpen = !pauseOpen)}>Pause</Button>
        <Menu bind:open={pauseOpen} anchor={pauseAnchor} items={pauseItems} placement="bottom-end" label="Pause notifications" />
      {/if}
    </SettingRow>
    <SettingRow label="Unread count on the Dock icon and in the title">
      <Switch label="Unread count on the Dock icon and in the title" checked={notifyPrefs.badge} onchange={(badge) => setNotifyPrefs({ badge })} />
    </SettingRow>
  </CardGroup>
</Page>
