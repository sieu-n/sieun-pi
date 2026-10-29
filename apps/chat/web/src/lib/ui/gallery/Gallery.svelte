<script lang="ts">
  import {
    Avatar,
    AvatarStack,
    Badge,
    Bubble,
    Button,
    CardGroup,
    Checkbox,
    Chip,
    DayDivider,
    Dialog,
    Disclosure,
    EmptyState,
    Field,
    IconButton,
    IdChip,
    Input,
    LoadingText,
    Markdown,
    Mascot,
    MentionChip,
    Menu,
    Meter,
    ModelPicker,
    NavItem,
    Page,
    PageHeader,
    PanelHeader,
    Picker,
    SearchField,
    Select,
    Skeleton,
    Spinner,
    StatusDot,
    Switch,
    SystemLine,
    Tabs,
    TextArea,
    TypingDots,
    toast,
    ICONS,
    type MenuEntry,
  } from "$lib/ui";
  import Icon from "$lib/ui/Icon.svelte";
  import { sidePanel } from "$lib/shell/side-panel.svelte";

  let tab = $state("one");
  let seg = $state("all");
  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLElement>();
  let ctxOpen = $state(false);
  let ctxPoint = $state<{ x: number; y: number } | null>(null);
  let dialogOpen = $state(false);
  let dlgMenuOpen = $state(false);
  let dlgMenuAnchor = $state<HTMLElement>();
  let pickerOpen = $state(false);
  let pickerAnchor = $state<HTMLElement>();
  let picked = $state("vent");
  let model = $state("claude-opus-5-5");
  let effort = $state("high");
  let sort = $state("recent");
  let unreadOnly = $state(true);
  let name = $state("");
  let query = $state("");
  let check = $state(true);
  let on = $state(true);
  let size = $state("md");
  let disc = $state(true);

  const menuItems: MenuEntry[] = $derived([
    { id: "copy", label: "Copy link", icon: "link", shortcut: "⌘C", onselect: () => toast.show("Copied link") },
    { id: "edit", label: "Edit message", icon: "edit" },
    { type: "submenu", id: "move", label: "Move to", icon: "folder", items: [{ id: "starred", label: "Starred" }, { id: "dm", label: "Direct messages" }] },
    { type: "separator" },
    { type: "label", label: "Sort" },
    { type: "radio", id: "recent", group: "sort", label: "Recent", checked: sort === "recent", onselect: () => (sort = "recent") },
    { type: "radio", id: "az", group: "sort", label: "A–Z", checked: sort === "az", onselect: () => (sort = "az") },
    { type: "checkbox", id: "unread", label: "Show unread only", checked: unreadOnly, onselect: (c) => (unreadOnly = c) },
    { type: "separator" },
    { id: "delete", label: "Delete message", icon: "trash", tone: "danger", onselect: () => toast.error("Deleted", { action: { label: "Undo", run: () => toast.success("Restored") } }) },
  ]);
  const pickerItems = [
    { id: "vent", label: "Vent", detail: "VP chat", group: "Chats", avatar: { name: "Vent", seed: "vent" } },
    { id: "frontend", label: "frontend bro", group: "Chats", avatar: { name: "frontend bro", seed: "frontend" } },
    { id: "general", label: "general", icon: "hash", group: "Channels" },
    { id: "launch", label: "launch", icon: "hash", group: "Channels" },
    { id: "ops", label: "ops", icon: "lock", group: "Channels", disabled: true },
  ];
  const models = [
    { id: "claude-opus-5-5", label: "Opus 5.5", family: "Claude" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", family: "Claude" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 sol", family: "OpenAI", detail: "via pool" },
  ];
  const md = `Here is the plan for **launch**, see [[projects/launch.html|the launch page]] and wiki:sessions/2026/10/28/plan.md.

- Run \`npm test\` in apps/chat.
- Ask @Vent about p12 when it lands.

| Part | Owner |
| --- | --- |
| shell | chat shell |
| server | chat server |

\`\`\`ts
const answer = 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  web --> server --> host
\`\`\``;
  const mdContext = {
    board: { chatId: "vent", titles: new Map([["p12", "Ship the shell"]]) },
    mentions: new Map([["vent", { id: "vent", kind: "agent" as const }]]),
  };
</script>

{#snippet paneBody()}
  <div style="padding: 16px">
    <p class="t-body">A side panel body is any snippet a page passes to sidePanel.open.</p>
  </div>
{/snippet}

<Page measure="wide">
  {#snippet header()}<PanelHeader title="lib/ui gallery" icon="spark" level={1} divider />{/snippet}

  <PageHeader title="Components" subtitle="Every shared part, in the states pages use." />

  <section data-gallery="buttons">
    <h2 class="t-label">Buttons</h2>
    <div class="row">
      <Button variant="primary">Primary</Button>
      <Button variant="accent" icon="arrow-up">Send</Button>
      <Button variant="outline" trailingIcon="chevron-down">Outline</Button>
      <Button variant="ghost" icon="plus">Ghost</Button>
      <Button variant="plain">Plain</Button>
      <Button variant="danger">Delete</Button>
      <Button variant="primary" size="sm" trailingIcon="chevron-down">New agent</Button>
      <Button variant="outline" loading>Saving</Button>
    </div>
    <div class="row">
      <IconButton icon="more" label="More actions" />
      <IconButton icon="more" label="More actions" variant="glass" size="sm" />
      <IconButton icon="plus" label="New" variant="chrome" />
      <IconButton icon="refresh" label="Refresh" variant="outline" loading />
      <IconButton icon="arrow-up" label="Send" variant="accent" />
      <IconButton icon="stop" label="Stop" variant="primary" />
    </div>
  </section>

  <section data-gallery="tabs">
    <h2 class="t-label">Tabs and pills</h2>
    <div class="row">
      <Tabs items={[{ id: "all", label: "All" }, { id: "solo", label: "Solo" }, { id: "team", label: "Team" }]} bind:value={seg} />
      <Tabs variant="chrome" items={[{ id: "one", label: "Messages", icon: "messages" }, { id: "two", label: "Agents", icon: "robot", badge: 2 }]} bind:value={tab} />
    </div>
    <Tabs variant="underline" items={[{ id: "one", label: "Your agents" }, { id: "two", label: "Jobs", badge: 4 }, { id: "three", label: "Marketplace", disabled: true }]} bind:value={tab} />
    <div class="row">
      <Badge value={3} /><Badge value={120} tone="danger" /><Badge value="New" tone="accent" /><Badge value="Main agent" tone="outline" /><Badge value="Cooldown" tone="warning" /><Badge value="2 resets" tone="success" /><Badge dot />
      <StatusDot status="online" /><StatusDot status="away" /><StatusDot status="offline" />
      <Chip label="Ann" prefix="from:" onremove={() => toast.show("removed")} />
      <Chip label="This conversation" icon="messages" onremove={() => {}} />
      <Chip label="Filter" onclick={() => {}} />
      <IdChip id="p12" chatId="vent" href="#/board" title="Ship the shell" />
      <IdChip id="t3" chatId="vent" />
      <MentionChip label="Vent" kind="agent" />
      <MentionChip label="Sieun" self />
      <MentionChip label="general" kind="channel" />
    </div>
  </section>

  <section data-gallery="avatars">
    <h2 class="t-label">Avatars</h2>
    <div class="row">
      <Avatar name="Sieun Park" kind="person" size={32} status="online" />
      {#each ["vent", "frontend", "crawler", "wiki", "slack", "intern"] as s (s)}
        <Avatar name={s} seed={s} size={32} status={s === "vent" ? "online" : s === "wiki" ? "away" : null} />
      {/each}
      <Avatar name="big" seed="honey" size={96} status="online" />
      <Mascot seed="chat shell" size={96} label="chat shell" />
      <AvatarStack members={[{ id: "a", name: "Bumble" }, { id: "b", name: "Fizz" }, { id: "c", name: "Honey" }, { id: "d", name: "Sieun", kind: "person" }]} size={20} />
      <TypingDots /><TypingDots mode="waiting" /><Spinner />
    </div>
  </section>

  <section data-gallery="messages">
    <h2 class="t-label">Messages</h2>
    <DayDivider at={Date.now() - 86_400_000} />
    <div class="col">
      <Bubble>Summary of yesterday: pricing research filed, crawler backlog fixed.</Bubble>
      <div style="align-self: flex-end"><Bubble own>Great work. Launch goes out tomorrow at 9.</Bubble></div>
      <SystemLine members={[{ id: "a", name: "Honey" }]} text="Honey was added by you" />
      <Bubble><Markdown text={md} context={mdContext} onartifact={(t) => toast.show(`open ${t}`)} onboardid={(id) => toast.show(`board ${id}`)} /></Bubble>
      <Bubble><Markdown text="Still writing the answer" streaming /></Bubble>
    </div>
  </section>

  <section data-gallery="floating">
    <h2 class="t-label">Menus, pickers, dialogs, toasts</h2>
    <div class="row">
      <Button bind:element={menuAnchor} onclick={() => (menuOpen = !menuOpen)} trailingIcon="chevron-down">Menu</Button>
      <button class="ctx" oncontextmenu={(e) => { e.preventDefault(); ctxPoint = { x: e.clientX, y: e.clientY }; ctxOpen = true; }}>Right click here</button>
      <Button bind:element={pickerAnchor} onclick={() => (pickerOpen = !pickerOpen)} trailingIcon="chevron-down">Pick: {picked}</Button>
      <ModelPicker {models} value={model} efforts={["minimal", "low", "medium", "high", "xhigh"]} {effort} onchange={(n) => { model = n.model; effort = n.effort ?? effort; }} />
      <Button onclick={() => (dialogOpen = true)}>Dialog</Button>
      <Button onclick={() => toast.success("Saved")}>Toast</Button>
      <Button onclick={() => sidePanel.open({ key: "gallery", title: "Side panel", icon: "side-panel", body: paneBody })}>Side panel</Button>
      <span use:tooltipDemo>Hover for tooltip</span>
    </div>
  </section>

  <section data-gallery="forms">
    <h2 class="t-label">Forms</h2>
    <div class="grid">
      <Field label="Name" id="g-name" hint="Shown on the agent card"><Input id="g-name" bind:value={name} placeholder="Agent name" /></Field>
      <Field label="Channel" id="g-ch" error="That name is taken"><Input id="g-ch" value="general" invalid /></Field>
      <SearchField bind:value={query} placeholder="Search agents" />
      <Select label="Size" showLabel bind:value={size} options={[{ value: "sm", label: "Small" }, { value: "md", label: "Medium" }]} />
      <Checkbox bind:checked={check} label="Notify me" />
      <Switch bind:checked={on} label="Check-ins" showLabel />
      <TextArea placeholder="Reply…" rows={2} />
      <Meter label="CPU" percent={42} /><Meter label="Memory" percent={76} /><Meter label="Disk" percent={93} />
    </div>
  </section>

  <section data-gallery="lists">
    <h2 class="t-label">Lists and cards</h2>
    <div class="grid">
      <div class="col">
        <NavItem label="For you" icon="inbox" selected />
        <NavItem label="Vent" detail="2 jobs working" icon="chat" />
        <NavItem variant="search" label="general" detail="#general · 12 members" icon="hash" highlighted />
        <NavItem variant="search" label="Vent" detail="VP chat">{#snippet leading()}<Avatar name="Vent" seed="vent" size={24} />{/snippet}</NavItem>
        <NavItem variant="inbox" label="Vent" detail="The job found two relay errors, both while the Mac slept. The canary itself is fine, and the relay log is clean since 02:11." selected>
          {#snippet leading()}<Avatar name="Vent" seed="vent" size={32} />{/snippet}
          {#snippet trailing()}9:41 PM{/snippet}
          {#snippet action()}<IconButton icon="check" label="Archive" size="xs" onclick={(e) => (e.stopPropagation(), toast.show("Archived"))} />{/snippet}
        </NavItem>
      </div>
      <CardGroup title="Hosts" description="Boxes that run agents.">
        <NavItem variant="card" label="us-metal02" detail="80 cores · Linux" icon="server">{#snippet trailing()}<StatusDot status="online" />{/snippet}</NavItem>
        <NavItem variant="card" label="Mac" detail="Owner's laptop" icon="server">{#snippet trailing()}<StatusDot status="offline" />{/snippet}</NavItem>
      </CardGroup>
      <Disclosure bind:open={disc} title="Done" detail="3">
        <p class="t-body-sm">Three finished steps.</p>
      </Disclosure>
      <Skeleton lines={3} />
      <LoadingText text="Loading messages…" delay={0} />
      <EmptyState icon="inbox" title="No drafts" description="Messages you start writing appear here.">
        {#snippet action()}<Button variant="primary" size="sm">New chat</Button>{/snippet}
      </EmptyState>
    </div>
  </section>

  <section data-gallery="icons">
    <h2 class="t-label">Icons</h2>
    <div class="icons">
      {#each Object.keys(ICONS) as name (name)}
        <span class="icon-cell" title={name}><Icon {name} /><span class="t-caption t-metadata">{name}</span></span>
      {/each}
    </div>
  </section>
</Page>

<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} />
<Menu bind:open={ctxOpen} anchor={ctxPoint} items={menuItems} />
<Picker bind:open={pickerOpen} anchor={pickerAnchor} items={pickerItems} value={picked} searchable onselect={(id) => (picked = id)} />
<Dialog bind:open={dialogOpen} title="Create agent" description="Name it and pick a model.">
  <Field label="Name" id="dlg-name"><Input id="dlg-name" placeholder="Agent name" /></Field>
  <div style="margin-top: 12px">
    <Button bind:element={dlgMenuAnchor} onclick={() => (dlgMenuOpen = !dlgMenuOpen)} trailingIcon="chevron-down">Sort: {sort}</Button>
  </div>
  <Menu bind:open={dlgMenuOpen} anchor={dlgMenuAnchor} items={menuItems} />
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>Cancel</Button>
    <Button variant="primary" onclick={() => (dialogOpen = false)}>Create agent</Button>
  {/snippet}
</Dialog>

<script lang="ts" module>
  import { tooltip } from "$lib/ui/tooltip";
  export function tooltipDemo(node: HTMLElement) {
    return tooltip(node, { text: "Search", shortcut: "⌘K" });
  }
</script>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
    align-items: start;
  }
  .ctx {
    padding: 6px 12px;
    border: 1px dashed var(--border-prominent);
    border-radius: 12px;
    background: transparent;
  }
  .icons {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 8px;
  }
  .icon-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px;
    border-radius: 12px;
    background: var(--surface-inset);
  }
</style>
