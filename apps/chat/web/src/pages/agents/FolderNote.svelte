<script lang="ts">
  import { hrefFor } from "$lib/router.svelte";

  /** The note on a job's page that its brief, working memory and memory are its agent's, edited on that agent's page. */
  let { agent, name }: { agent: string; name: string } = $props();
</script>

<p class="t-caption belongs" data-testid="folder-owner">
  This job belongs to <a href={hrefFor("agents", [agent])}>{name}</a>. It loads the brief, working memory and memory of {name}, which you edit on its page.
</p>
