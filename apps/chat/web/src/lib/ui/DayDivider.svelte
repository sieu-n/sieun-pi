<script lang="ts">
  import { dayLabel, msUntilMidnight } from "./datetime";

  type Props = {
    at: number;
    /** calendar is the glyph and label between two lines; pill is Slack's thin line with the label in a centered rounded pill. */
    variant?: "calendar" | "pill";
  };
  let { at, variant = "calendar" }: Props = $props();
  let now = $state(Date.now());

  $effect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        now = Date.now();
        arm();
      }, msUntilMidnight() + 500);
    };
    arm();
    return () => clearTimeout(timer);
  });

  const label = $derived(dayLabel(at, now));
  const date = $derived(new Date(at).getDate());
</script>

{#if variant === "pill"}
  <div class="pill-divider" role="separator" aria-label={label} data-variant="pill">
    <span class="pill">{label}</span>
  </div>
{:else}
  <div class="divider" role="separator" aria-label={label}>
    <span class="cal" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20">
        <rect x="2.5" y="3" width="15" height="14.5" rx="3" fill="var(--surface-panel)" stroke="var(--border-standard)" />
        <path d="M2.5 6a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v1.5h-15z" fill="#e5484d" />
        <text x="10" y="15" text-anchor="middle">{date}</text>
      </svg>
    </span>
    <span class="label">{label}</span>
    <span class="line"></span>
  </div>
{/if}

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 20px 0;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .divider::before {
    content: "";
    flex: 1;
    height: 0.5px;
    background: var(--border-standard);
    box-shadow: 0 0 0 0.25px var(--border-standard);
  }
  .line {
    flex: 1;
    height: 0.5px;
    background: var(--border-standard);
    box-shadow: 0 0 0 0.25px var(--border-standard);
  }
  .cal {
    display: inline-flex;
    margin-left: 4px;
  }
  text {
    font: 500 7.5px var(--font-sans);
    fill: var(--text-standard);
  }
  .label {
    margin-right: 4px;
  }
  .pill-divider {
    position: relative;
    display: flex;
    justify-content: center;
    margin: 16px 0 8px;
  }
  .pill-divider::before {
    content: "";
    position: absolute;
    top: 50%;
    right: 0;
    left: 0;
    height: 1px;
    background: var(--border-standard);
  }
  .pill {
    position: relative;
    padding: 3px 14px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-pill);
    background: var(--surface-panel);
    color: var(--text-standard);
    font: var(--text-caption);
    font-weight: 500;
    letter-spacing: var(--tracking-caption);
  }
</style>
