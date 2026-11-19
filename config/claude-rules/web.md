---
paths:
  - '**/*.{svelte,vue,astro,html,css,scss,jsx,tsx}'
---

# Web UI

Read `~/.prime/agent/skills/modern-web-guidance/SKILL.md` and run its search before you write or change HTML, CSS or clientside JS, such as a dialog, form, table, layout, animation or date field.

- Search one UI pattern at a time with a 2 to 5 word query and no framework or app names, such as `modern-web-guidance search "light dismiss dialog"`, then `retrieve` the ids that match and check your code against the guide before you finish.
- The CLI is installed on us-metal02, and on the Mac you run it as `npx -y modern-web-guidance@latest`.
- Name each guide that shaped the code in the commit message or reply, and skip `legacy-scan` unless the task asks to modernize a whole codebase.
- A copy-only edit, a test, a build config or a rename needs no search, and the repo's own rules and design system win where they differ from a guide.
- From 11-05 to 11-20 no Prime session read the skill, although jobs built HTML, CSS and Svelte UI on 5180, slack-green and auto-sns-agent every day, so this user rule loads with the first frontend file a session touches in any repo.
