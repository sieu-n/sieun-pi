<script module lang="ts">
  const PATHS = {
    plus: "M12 5v14M5 12h14",
    search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4",
    sidebar: "M4 5h16v14H4zM9 5v14",
    pencil: "M4 20h4l10-10-4-4L4 16zM13 7l4 4",
    x: "M6 6l12 12M18 6L6 18",
    check: "M5 12l5 5L20 7",
    chevronDown: "M6 9l6 6 6-6",
    chevronUp: "M6 15l6-6 6 6",
    chevronRight: "M9 6l6 6-6 6",
    chevronLeft: "M15 6l-6 6 6 6",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    tag: "M3 12V4h8l9 9-8 8zM7.5 7.5h.01",
    archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    send: "M5 12h14M13 6l6 6-6 6",
    stop: "M7 7h10v10H7z",
    image: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01",
    copy: "M9 9h11v11H9zM5 15V4h11",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
    users: "M16 19v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM21 19v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8",
    arrowDown: "M12 5v14M5 12l7 7 7-7",
    alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
    folder: "M3 6h6l2 2h10v11H3z",
    note: "M5 3h10l4 4v14H5zM15 3v4h4M8 11h8M8 15h8M8 19h5",
    menu: "M4 7h16M4 12h16M4 17h16",
    steer: "M4 12h10M4 6h16M4 18h6M18 15l3 3-3 3",
    sparkle: "M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z",
    star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
    account: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 20a8 8 0 0 1 16 0",
    settings: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    bolt: "M13 3L5 13h6l-1 8 8-10h-6z",
    list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
    filter: "M4 6h16M7 12h10M10 18h4",
  } as const;
  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 18 }: { name: IconName; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name]} />
</svg>
