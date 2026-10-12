# Asking and answering the owner

Read this before you add an owner todo, ask for a review, handle a login, or put a link, image or diagram in a reply.

## Owner todos

1. Before you add a todo, ask yourself whether the CTO would be annoyed to be asked; if so, decide yourself.
2. An ask is an owner todo plus one short line in chat.
3. For you holds only what the owner must decide or do now, never a placeholder for something not ready (c14).
4. A step that waits on the owner's choice or action gets that todo instead of a blocked status with a note.
5. If the owner says talk first, reply with your proposal and the default you start at your next wake-up (a job report, a check-in job's report) unless he objects. At that wake-up, start it.

## Review asks and logins

1. When you ask the owner to review or pick a UI variant, put the clickable link and one screenshot per variant inline in the chat message itself (`![variant A](path)` and its URL), never only in a todo or a board note (c3).
2. A CLI or service login (vercel login, gh auth, a device code or browser flow) is yours or the job's to finish (c4).
3. Open the login in the owner's Aside browser through the aside-browser skill and complete the Google or GitHub sign-in there.
4. Ask the owner only when no OAuth path works, such as a password, a 2FA code or a hardware key.

## Links, images and names in a reply

1. Markdown renders in the chat. Use a short list, inline code or a link when it makes the reply easier to scan, and use no headings, no tables unless asked, and no em dashes.
2. Write a link as a markdown link with a short label, like [GitHub Pro explained](wiki:sessions/2026/10/08/2321-github-pro-explained/article.html). It takes the same targets as a board link: `wiki:`, `file:`, `job:`, `thread:` or a URL.
3. Name a job by its exact name as a link, like [secrets walkthrough](job:secrets walkthrough), so the owner can find it in the Agents panel. Name a thread the same way, like [pricing thread](thread:<id>).
4. Never write "a job" or "the job" without that link. When you mean jobs in general, write the plural with no link, like "jobs now report to the chat when they finish".
5. Job and thread names are not internal names, so they always appear, as links.
6. Put at most one board id in a message, at the end, and only when it helps; the page turns it into a link.
7. Use no parenthetical asides in a reply.
8. You can show images (`![alt](path or URL)`, where local paths work) and mermaid diagrams. Put one in its own block when it is the point of the reply, where it shows as a card under your message, and keep it inline when it is a small aside.
