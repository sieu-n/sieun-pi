import type { MemoryGroupId } from "./shared/types.ts";

/**
 * The group of a pressure feed owner key (scripts/sieun/mac/pressure-feed.c in auto-sns-agent), first match. The feed already folds helpers
 * into their app and a process tree into its chat or pm2 app, so the key alone decides. Root processes such as WindowServer and kernel_task
 * have no owner rows, so System gets the feed's wired memory instead.
 */
export const GROUP_RULES: [MemoryGroupId, RegExp][] = [
  ["agents", /^chat:|^other:(prime-agent|chat-service|pi-pool|pool\.py|rlm)/i],
  ["docker", /^docker-vm$|^other:(OrbStack|Docker|com\.docker|colima|lima|vfkit|qemu)/i],
  ["dev", /^pm2:|^other:(pm2-daemon|next-server|vite|convex|turbo)/i],
  ["browsers", /^browser:|^other:com\.apple\.WebKit/i],
  ["coding", /^other:(Visual Studio Code|Code|Cursor|Claude|Zed|Xcode|Ghostty|iTerm2?|Terminal|Warp|claude|codex)/i],
  ["system", /^other:(com\.apple\.|Dock$|Finder$|Siri|System Settings$|Spotlight|ControlCenter|NotificationCenter|SystemUIServer|WindowManager|loginwindow)/i],
];
export const groupOf = (owner: string): MemoryGroupId => GROUP_RULES.find(([, rule]) => rule.test(owner))?.[0] ?? "other";
