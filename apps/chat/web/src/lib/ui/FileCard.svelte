<script lang="ts" module>
  /** The short type a card shows under the name, from the file's extension or its type, as Slack shows "PDF" or "Zip". */
  export function fileKind(name: string, mimeType: string): string {
    const ext = name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
    if (ext) return ext.toUpperCase();
    const sub = mimeType.split("/")[1]?.split(/[.+-]/).pop();
    return sub && sub !== "octet" && sub !== "stream" ? sub.toUpperCase() : "File";
  }

  /** A byte count as Finder writes it: 12 KB, 3.4 MB. */
  export function fileSize(bytes: number): string {
    if (bytes < 1000) return `${bytes} B`;
    const [n, unit] = bytes < 1e6 ? [bytes / 1e3, "KB"] : bytes < 1e9 ? [bytes / 1e6, "MB"] : [bytes / 1e9, "GB"];
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${unit}`;
  }

  const TONES: Record<string, string> = {
    PDF: "pdf", ZIP: "archive", GZ: "archive", TAR: "archive", TGZ: "archive", "7Z": "archive", RAR: "archive",
    CSV: "sheet", XLS: "sheet", XLSX: "sheet", NUMBERS: "sheet", TSV: "sheet",
    DOC: "doc", DOCX: "doc", PAGES: "doc", TXT: "doc", MD: "doc", RTF: "doc",
    PPT: "slides", PPTX: "slides", KEY: "slides",
  };
</script>

<script lang="ts">
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";

  type Props = {
    name: string;
    mimeType: string;
    /** Bytes; left out while it is not known. */
    size?: number | undefined;
    /** The upload's URL, which the card opens in a new tab: a PDF or text shows there and any other file downloads. */
    href?: string | undefined;
    /** Shows an x that drops the file, as a composer does before the send. */
    onremove?: () => void;
  };
  let { name, mimeType, size, href, onremove }: Props = $props();

  const kind = $derived(fileKind(name, mimeType));
  const meta = $derived(size === undefined ? kind : `${kind} · ${fileSize(size)}`);

  /** Saves the file under its name; where `download` is ignored, as in the Mac app, the new tab gets an attachment that downloads. */
  function download() {
    if (!href) return;
    const a = document.createElement("a");
    a.href = `${href}?name=${encodeURIComponent(name)}&download=1`;
    a.download = name;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }
</script>

<div class="file-card" data-tone={TONES[kind] ?? "file"} data-testid="file-card">
  <span class="badge" aria-hidden="true"><Icon name="file" size={20} /></span>
  <span class="text">
    {#if href}
      <a class="name" href="{href}?name={encodeURIComponent(name)}" target="_blank" rel="noopener" title={name}>{name}</a>
    {:else}
      <span class="name" title={name}>{name}</span>
    {/if}
    <span class="meta">{meta}</span>
  </span>
  {#if href}
    <span class="action"><IconButton icon="download" label="Download {name}" size="sm" onclick={download} /></span>
  {/if}
  {#if onremove}
    <span class="remove"><IconButton icon="close" label="Remove {name}" size="xs" variant="glass" onclick={onremove} /></span>
  {/if}
</div>

<style>
  .file-card {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 300px;
    max-width: 100%;
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2);
    border: 1px solid var(--border-standard);
    border-radius: 8px;
    background: var(--surface-panel);
    color: var(--text-standard);
  }
  .badge {
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    background: var(--tone);
    color: var(--text-on-accent);
  }
  .file-card[data-tone="file"] { --tone: var(--neutral-9); }
  .file-card[data-tone="pdf"] { --tone: var(--text-danger); }
  .file-card[data-tone="sheet"] { --tone: var(--chart-series-2); }
  .file-card[data-tone="doc"] { --tone: var(--accent-9); }
  .file-card[data-tone="slides"] { --tone: var(--chart-series-3); }
  .file-card[data-tone="archive"] { --tone: var(--chart-series-4); }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .name {
    overflow: hidden;
    color: inherit;
    font: var(--text-body-sm);
    font-weight: 500;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  a.name::after {
    content: "";
    position: absolute;
    inset: 0;
  }
  a.name:hover {
    text-decoration: underline;
  }
  .meta {
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .action {
    position: relative;
    z-index: 1;
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }
  .file-card:hover .action,
  .file-card:focus-within .action {
    opacity: 1;
  }
  .remove {
    position: absolute;
    top: -6px;
    right: -6px;
    z-index: 1;
  }
</style>
