<script lang="ts">
  import type { Status } from "./types";
  type Props = { status: Status; size?: number; label?: string };
  let { status, size = 8, label }: Props = $props();
</script>

<span
  class="status {status}"
  style:width="{size}px"
  style:height="{size}px"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
></span>

<style>
  .status {
    display: inline-block;
    flex: none;
    border-radius: 50%;
  }
  .online {
    background: var(--status-online);
    box-shadow: inset 0 0 0 1px var(--status-online-border);
  }
  .away {
    background: var(--status-away);
  }
  .offline {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--status-offline);
  }
  .busy {
    background: var(--border-danger);
  }
</style>
