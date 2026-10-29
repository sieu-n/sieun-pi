# UX notes

The chat's layout and interaction ideas come from Buzz 1.0 by Block, [block/buzz-app](https://github.com/block/buzz-app), which is licensed under Apache 2.0. We thank its authors for the design.

We copied no Buzz code, icon, image, font file or mascot art. Every component here is our own code, written from notes on Buzz's sizes, colors and behavior. The icons in `web/src/lib/ui/icons.ts` are drawn for this app, and the agent avatars are generated from each agent's id. Inter and JetBrains Mono come from the Fontsource npm packages under the SIL Open Font License.

## Ideas we took

1. The window is a dotted gray shell with white panels: a 260 px resizable sidebar, one main panel with 24 px corners, and a 420 px resizable side panel for threads and boards.
2. One 40 px capsule centered in the 56 px top bar holds the + menu, the page pills and the search pill.
3. The sidebar's All, Solo and Team control is a view filter over one list, and it follows you to the right group when you open a chat from elsewhere.
4. One accent color, a citrus lime, paints only own bubbles, the Send button and the selected sidebar row, and everything else stays neutral.
5. In a DM or a chat every message sits in a bubble, stacks merge within five minutes, and the avatar sits at the bottom of a stack.
6. People have circle avatars and agents have squircle avatars, each with a status dot.
7. Agents show work three ways: typing dots in the sidebar row and the thread pill, the agent under the message it answers, and a full transcript.
8. Mentions are chips, and a mention of the owner is lime with black ink.
9. A burst of membership changes within an hour merges into one system line.
10. Day dividers use relative labels such as Today and Yesterday, and they update at midnight.
11. Loading text waits one second before it shows, so fast loads never flicker.
12. Keyboard focus rings show only after keyboard use, so mouse clicks leave no ring.
13. Search opens with Cmd K, Cmd F scopes it to the open conversation, and it takes `from:`, `in:`, `after:` and `before:` operators.
14. The mention list never reorders under the pointer, and a space completes a mention only when the typed name is exact and unique.

## Channels read like Slack

These follow the owner's ask of 10-30, "Chat하고 다르게 Channel should feel kinda like Slack."

1. A channel or a Solo room draws full-width left-aligned rows for everyone, the owner too, with no bubbles and no lime.
2. The first post of a run by one sender within five minutes shows a 36 px avatar, the name and the time, and each follow-up shows only its time in the gutter on hover.
3. A row lights up on hover and shows its actions at the top right: Reply in thread, Show work, Copy link and Copy message.
4. A root post's thread summary shows the repliers' avatars, "N replies" and the time of the last reply, which turns into "View thread" on hover.
5. Day dividers are a thin line with a centered pill, and the oldest page opens with "This is the very beginning of the #name channel" and the purpose.
6. The header holds the name, the purpose and a member button with up to three avatars and the count, which opens the member list.
7. The thread pane is titled "Thread" with the channel name beside it, shows the root post, a "N replies" rule and the replies, and names the day in each time instead of drawing day dividers.

## Solo rooms

These are ours, not Buzz's.

1. A Solo room pins its agenda under the header, with its agents as removable chips beside an Add button, and its side panel shows one invited agent's board at a time behind a tab per agent.
2. Closing a Solo room swaps the composer for a banner with Reopen, and the sidebar folds closed rooms under "Done" between the open rooms and the untitled chats.
