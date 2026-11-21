import { api, type ConversationId } from "$lib/api";
import { toast } from "$lib/ui/toast.svelte";

/**
 * Pins a room post or un-pins it, for the message menu and the header's Pinned list alike (server/pins.ts). An un-pin is one click, so its
 * toast carries Undo, which pins the post again. `after` runs once the server took the change, such as the header's list re-reading.
 */
export function setPin(room: ConversationId, post: string, pinned: boolean, after?: () => void): void {
  api.pin(room, post, pinned).then(
    () => {
      after?.();
      if (pinned) return;
      toast.show("Message un-pinned", {
        action: { label: "Undo", run: () => api.pin(room, post, true).then(() => after?.(), () => toast.error("Could not pin the message again")) },
      });
    },
    () => toast.error(pinned ? "Could not pin the message" : "Could not un-pin the message"),
  );
}
