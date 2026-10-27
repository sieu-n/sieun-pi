/** The archive confirm's words: the chat by name, and what archiving does to a busy chat and to its Slack channel. */
export function archivePrompt(input: { name: string; busy: boolean; slackChannel: string | null }): { title: string; body: string; label: string } {
  const name = input.name.trim() || "this chat";
  const parts = [input.busy ? "Its running turn stops." : "", input.slackChannel ? `Its Slack channel #${input.slackChannel} is archived too.` : "", "Undo from the toast, or unarchive it later from the sidebar."];
  return { title: `Archive ${name}?`, body: parts.filter(Boolean).join(" "), label: input.busy ? "Stop and archive" : "Archive" };
}
