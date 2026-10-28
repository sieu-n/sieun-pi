# lib/ui

This folder is the one shared component set of the chat web client (owner rule c78). Every page takes its buttons, pills, avatars, bubbles, menus, popovers, dialogs, toasts, pickers and panels from here and never draws a look-alike. When a page needs a part or a variant that is missing, ask 'chat shell' for it.

Import a part from the barrel or from its file.

```ts
import { Button, Menu, toast, type MenuEntry } from "$lib/ui";
import Avatar from "$lib/ui/Avatar.svelte";
```

Open http://127.0.0.1:5185/#/ui with the dev server running to see every part in its states. The gallery lives in `gallery/Gallery.svelte`.

## Tokens

Colors, chart series (`--chart-series-1` to `4`), type, radii, shadows, spacing, motion and layout sizes are CSS variables in `src/styles/tokens.css`, with a dark set under `:root[data-color-mode="dark"]`. Use the variables and never a raw hex value. The type scale has utility classes in `src/styles/base.css`, such as `t-body-sm`, `t-caption` and `t-label`. Only weights 400 and 500 are used.

## Controls

| Part | What it is | Main props |
|---|---|---|
| `Button` | A pill button. | `variant` primary, accent, outline, ghost, plain or danger; `size` sm, md or lg; `icon`, `trailingIcon`, `loading`, `href`, `full`, `bind:element` |
| `IconButton` | A square or round icon button with a tooltip from its label. | `icon`, `label`, `variant` ghost, glass, chrome, outline, accent or primary; `size` xs, sm, md or lg; `loading`, `pressed`, `shortcut` |
| `Tabs` | Segmented control, top bar pills or underlined panel tabs. | `items`, `bind:value`, `variant` segmented, chrome or underline; `size`, `full`, `embedded`, `onchange` |
| `Chip` | A small rounded chip, removable or clickable. | `label`, `prefix` such as "from:", `icon`, `leading`, `selected`, `onclick`, `onremove` |
| `Badge` | A count, a short label or a dot. | `value`, `tone` neutral, accent, danger, strong or outline; `dot` |
| `Input` | A one-line text field. | `bind:value`, `size`, `icon`, `prefix`, `suffix`, `invalid`, `bind:element`, plus any input attribute |
| `TextArea` | A multi-line field that grows with its text. | `bind:value`, `rows`, `maxRows`, `invalid` |
| `SearchField` | A search input. The palette variant is the 78 px search dialog row with no leading icon. | `variant` inline or palette; `icon`, `prefix` for operator chips, `suffix`, `clearable`, `bind:element` |
| `Field` | A label, hint and error around one control. | `label`, `id`, `hint`, `error`, `optional`, `inline` |
| `Checkbox` | A checkbox with a label. | `bind:checked`, `label`, `indeterminate`, `shape` square or round |
| `Switch` | An on and off switch. | `bind:checked`, `label`, `showLabel` |
| `Select` | A native select styled as a pill. | `bind:value`, `options`, `label`, `showLabel`, `size` |

## Identity and status

| Part | What it is | Main props |
|---|---|---|
| `Avatar` | A circle for the owner and people, a squircle for agents that draws the seeded mascot. | `name`, `kind` person or agent, `src`, `seed`, `size`, `status` |
| `Mascot` | The seeded agent figure with no clip, for agent cards and backdrops. `mascotSvg(seed, id?)` returns the same SVG as a string. | `seed`, `size`, `id`, `label` |
| `AvatarStack` | Overlapping small avatars with a "+N". | `members`, `size`, `max` |
| `StatusDot` | Online, away, offline or busy. | `status`, `size` |
| `TypingDots` | The agent working signal. | `mode` working or waiting, `label` |
| `MentionChip` | An @mention, lime when it names the owner. | `label`, `kind` person, agent or channel; `self`, `href`, `onclick`, `onremove` |
| `IdChip` | A board id such as p12, t3 or d9 with its hashed color. It carries `data-board-id` and `data-chat-id`. | `id`, `chatId`, `href`, `title`, `onclick` |

## Messages

| Part | What it is | Main props |
|---|---|---|
| `Bubble` | A received or own message bubble, 8 px 16 px padding, about 21 px radius. | `own`, `position`, `footer` for reactions, `highlighted` |
| `DayDivider` | The calendar glyph and a relative day label that updates at midnight. | `at` |
| `SystemLine` | A centered caption line with up to 3 small avatars. | `members`, `text` |
| `Markdown` | Sanitized markdown with code blocks (language, Copy, a fold past 20 lines), tables with a sticky header, GitHub callouts, task lists, `<details>` folds, wiki, job, thread and file path pills, board id chips, mentions, GitHub cards, web links with the site icon, images with a lightbox, mermaid drawn when it scrolls near, and a streaming caret. | `text`, `inline`, `context`, `streaming`, `onartifact`, `onboardid`, `onmention` |
| `Mermaid` | One mermaid diagram in the design tokens of the current color mode; a parse error goes to `onerror`, or shows with the source. | `source`, `onerror` |
| `Lightbox` | A full-screen image view. | `src`, `alt`, `onclose` |

`renderMarkdown(text, context)` and `renderInline(text, context)` return the same HTML as strings, for places that cannot mount a component. The context names the chat's board ids (`board`) and the mention targets (`mentions`), and only those turn into chips.

## Floating surfaces

| Part | What it is | Main props |
|---|---|---|
| `Popover` | A glass or solid surface next to an element or a point. Esc and an outside press close it. | `bind:open`, `anchor`, `placement`, `surface`, `width`, `onclose` |
| `Menu` | A menu of actions, radios, checkboxes, labels, separators and submenus. A point anchor makes it a context menu. | `bind:open`, `anchor`, `items: MenuEntry[]`, `placement` |
| `Picker` | The one shared picker for models, agents, channels and any other choice, with groups, a filter and keyboard moves. With `typeahead` it filters by an outside query, never takes focus and reads arrow keys, Enter and Tab from the text box, as the composer's @ and # lists need. | `bind:open`, `anchor`, `items: PickerItem[]`, `value`, `multiple`, `searchable`, `typeahead`, `onselect`, `footer` |
| `ModelPicker` | A trigger plus a Picker grouped by model family, with a thinking effort control and a custom model id. | `models`, `value`, `efforts`, `effort`, `variant` pill or field, `bind:open`, `onchange` |
| `Dialog` | A modal card, or the search palette anchored 128 px from the top. An outside click leaves a dirty dialog open. | `bind:open`, `title`, `description`, `presentation` center or search, `dirty`, `initialFocus`, `actions` |
| `toast` | `toast.show(text)`, `toast.success(text)`, `toast.error(text, { action })`. `Toaster` is mounted once in App. | |
| `tooltip` | `use:tooltip={"Close"}` or `use:tooltip={{ text, shortcut, placement }}`. | |

## Layout

| Part | What it is | Main props |
|---|---|---|
| `Panel` | The white panel surface with the panel shadow, or an inset or card fill. | `variant`, `radius`, `padding`, `column` |
| `PanelHeader` | The 40 px header with an icon, a title, trailing actions and a close button. | `title`, `icon`, `titleContent`, `actions`, `onclose`, `closeLabel`, `divider` |
| `Page` | A full page body: a fixed header and a centered scrolling column. | `header`, `measure` narrow, default, wide or full |
| `PageHeader` | A page or section title with a subtitle, actions and a row below. | `title`, `subtitle`, `actions`, `below`, `size` page or section |
| `CardGroup` | A titled card of rows with hairlines between them, for settings, hosts and usage. | `title`, `description`, `actions` |
| `NavItem` | A list row with a leading icon or avatar, a two-line label and trailing content. The inbox variant has a 32 px lead, a two-line preview, a gray selected fill and an `action` that replaces `trailing` on hover. | `variant` row, search (64 px), card or inbox; `selected`, `highlighted`, `unread`, `href`, `leading`, `trailing`, `action`, `labelContent` |
| `SplitPane` | A list and a resizable detail pane, for inbox-style pages. | `list`, `detail`, `detailWidth`, `storageKey` |
| `ResizeHandle` | A 14 px drag seam that also takes arrow keys. | `size`, `min`, `max`, `edge`, `onresize`, `oncommit` |
| `Disclosure` | A header that shows or hides its body. | `bind:open`, `title`, `detail`, `actions` |
| `Meter` | A 4 px bar that turns amber at 70 and red at 90. | `percent`, `label`, `value`, `warn`, `danger`, `inverted` |
| `EmptyState` | An icon, a title, a line of text and actions. | `title`, `description`, `icon`, `action`, `art` |
| `Spinner`, `LoadingText`, `Skeleton` | Loading marks. LoadingText waits one second before it shows, so fast loads never flicker. | `text`, `delay`, `lines` |
| `Icon` | Our own 20 px line icons, listed in `icons.ts`. | `name`, `size`, `label` |

## Helpers

`datetime.ts` gives `dayLabel`, `timeLabel`, `stampLabel` and `ageLabel`. `hash.ts` gives `hueFor(seed)` and `initials(name)`. `keyboard.ts` gives `modKey(event)`, `isMac` and the keyboard-only focus ring. `floating.ts` gives `place` and the `portal` action.

## Shell

The shell in `src/lib/shell` uses these parts. Pages reach it through three small stores.

1. `router` in `$lib/router.svelte` gives `router.route`, `router.conversationId`, `navigate`, `openConversation(id, { thread, messageId })` and `setParams`.
2. `sidePanel` in `$lib/shell/side-panel.svelte` opens one 420 px resizable pane with `sidePanel.open({ key, title, body })`.
3. `search` in `$lib/shell/search.svelte` holds the Cmd K and Cmd F search state that pages/search reads.
