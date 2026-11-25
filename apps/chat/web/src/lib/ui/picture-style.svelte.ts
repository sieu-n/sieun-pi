import { DEFAULT_PICTURE_STYLE, isPictureStyle, type PictureStyle } from "./agent-picture";

/** The agent picture style this browser shows. `?avatars=<style>` in the page URL shows a style for one load without saving it. */
const KEY = "chat.agentPicture";

class PictureStyleSetting {
  value = $state<PictureStyle>(read());

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
