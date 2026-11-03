<script lang="ts" module>
  import { ICONS, isIconName } from "./icons";

  const drawn = new Map<string, DocumentFragment>();

  /** Fills the icon with a clone of its paths, parsed once per name, since {@html} parses the markup again for every icon a timeline row draws. */
  function paths(node: SVGSVGElement, name: string) {
    const draw = (next: string) => {
      let parts = drawn.get(next);
      if (!parts) {
        const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        holder.innerHTML = isIconName(next) ? ICONS[next] : "";
        parts = document.createDocumentFragment();
        parts.append(...holder.childNodes);
        drawn.set(next, parts);
      }
      node.replaceChildren(parts.cloneNode(true));
    };
    draw(name);
    return { update: draw };
  }
</script>

<script lang="ts">
  type Props = {
    name: string;
    size?: number;
    /** Accessible label. Without it the icon is decorative and hidden from screen readers. */
    label?: string;
    class?: string;
  };
  let { name, size = 20, label, class: className = "" }: Props = $props();
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
  use:paths={name}
></svg>

<style>
  .icon {
    flex: none;
    display: inline-block;
    vertical-align: middle;
  }
</style>
