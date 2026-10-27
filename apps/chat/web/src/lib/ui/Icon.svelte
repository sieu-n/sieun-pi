<script lang="ts">
  import { ICONS, isIconName } from "./icons";

  type Props = {
    name: string;
    size?: number;
    /** Accessible label. Without it the icon is decorative and hidden from screen readers. */
    label?: string;
    class?: string;
  };
  let { name, size = 20, label, class: className = "" }: Props = $props();
  const markup = $derived(isIconName(name) ? ICONS[name] : "");
</script>

<svg
  class="icon {className}"
  width={size}
  height={size}
  viewBox="0 0 20 20"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
  data-icon={name}
>
  {@html markup}
</svg>

<style>
  .icon {
    flex: none;
    display: inline-block;
    vertical-align: middle;
  }
</style>
