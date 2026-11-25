import { agents } from "$lib/api";
import { DEFAULT_PICTURE_STYLE, assignPictures, isPictureStyle, type Assignment, type PictureStyle } from "./agent-picture";

/** The agent picture style this browser shows. `?avatars=<style>` in the page URL shows a style for one load without saving it. */
const KEY = "chat.agentPicture";

class PictureStyleSetting {
  value = $state<PictureStyle>(read());
  /** Each registered agent's own color and symbol, keyed by agent id. */
  readonly assigned = $derived(assignPictures(agents.list));

  /** The color and symbol a new agent with this name would get, for the create dialog's preview. */
  preview(name: string): Assignment | undefined {
    return assignPictures([...agents.list, { id: "new", name, createdAt: Number.MAX_SAFE_INTEGER }]).get("new");
  }

  set(style: PictureStyle): void {
    this.value = style;
    try {
      if (style === DEFAULT_PICTURE_STYLE) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, style);
    } catch {}
  }
}

function read(): PictureStyle {
  if (typeof window === "undefined") return DEFAULT_PICTURE_STYLE;
  const flag = new URLSearchParams(location.search).get("avatars");
  if (isPictureStyle(flag)) return flag;
  try {
    const saved = localStorage.getItem(KEY);
    return isPictureStyle(saved) ? saved : DEFAULT_PICTURE_STYLE;
  } catch {
    return DEFAULT_PICTURE_STYLE;
  }
}

export const pictureStyle = new PictureStyleSetting();
