/**
 * The report preview card's triggers: any element with `data-preview-chat` and `data-preview-job` (a sidebar job row, a plan step that
 * links a job, a `job:` link chip, a folded updates line, a job chip in a bubble). A mouse resting on one for 300 ms, or a touch or pen
 * held on it for 500 ms, shows the card for that job; the card stays while the pointer is over the trigger or the card itself and goes
 * when the pointer rests elsewhere for 120 ms, on Escape, on a press outside the card, or on any scroll. A press on the trigger itself
 * closes the card too, since its click opens the full thing. One document listener set serves every trigger on the page.
 */
export interface PreviewTrigger { chat: string; job: string; anchor: HTMLElement }
export const HOVER_DELAY = 300;
export const PRESS_DELAY = 500;
export const LEAVE_GRACE = 120;
const PRESS_SLOP = 8;

/** The trigger an event landed on, or null. A trigger whose job attribute is empty (a folded run of notes only) is none. */
export function triggerOf(target: EventTarget | null): PreviewTrigger | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>("[data-preview-job]");
  const job = anchor?.dataset.previewJob;
  const chat = anchor?.dataset.previewChat;
  return anchor && job && chat ? { chat, job, anchor } : null;
}

export interface PreviewHost { show(trigger: PreviewTrigger): void; hide(): void; card(): HTMLElement | null; shown(): PreviewTrigger | null }

export function previewTriggers(host: PreviewHost): () => void {
  let hover: ReturnType<typeof setTimeout> | undefined;
  let leave: ReturnType<typeof setTimeout> | undefined;
  let press: ReturnType<typeof setTimeout> | undefined;
  let armed: HTMLElement | null = null;
  let pressStart = { x: 0, y: 0 };
  const inside = (target: EventTarget | null): boolean => {
    const shown = host.shown();
    return target instanceof Node && Boolean(shown?.anchor.contains(target) || host.card()?.contains(target));
  };
  const disarm = () => { clearTimeout(hover); armed = null; };
  const hideSoon = () => { clearTimeout(leave); if (host.shown()) leave = setTimeout(() => host.hide(), LEAVE_GRACE); };
  const stay = () => clearTimeout(leave);
  const onOver = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (inside(event.target)) { stay(); return; }
    const trigger = triggerOf(event.target);
    if (trigger) {
      if (armed === trigger.anchor) return;
      disarm();
      armed = trigger.anchor;
      hover = setTimeout(() => { armed = null; host.hide(); host.show(trigger); }, HOVER_DELAY);
      return;
    }
    disarm();
    hideSoon();
  };
  const onOut = (event: PointerEvent) => { if (event.pointerType === "mouse" && event.relatedTarget === null) { disarm(); hideSoon(); } };
  const endPress = () => { clearTimeout(press); press = undefined; };
  const onDown = (event: PointerEvent) => {
    disarm();
    if (!(event.target instanceof Node && host.card()?.contains(event.target))) host.hide();
    if (event.pointerType === "mouse") return;
    const trigger = triggerOf(event.target);
    if (!trigger) return;
    pressStart = { x: event.clientX, y: event.clientY };
    endPress();
    press = setTimeout(() => {
      press = undefined;
      const swallow = (later: Event) => { later.preventDefault(); later.stopPropagation(); };
      trigger.anchor.addEventListener("click", swallow, { capture: true, once: true });
      trigger.anchor.addEventListener("contextmenu", swallow, { capture: true, once: true });
      setTimeout(() => { trigger.anchor.removeEventListener("click", swallow, { capture: true }); trigger.anchor.removeEventListener("contextmenu", swallow, { capture: true }); }, 1000);
      host.show(trigger);
    }, PRESS_DELAY);
  };
  const onMove = (event: PointerEvent) => { if (press !== undefined && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > PRESS_SLOP) endPress(); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !host.shown()) return;
    event.preventDefault();
    event.stopPropagation();
    host.hide();
  };
  const onScroll = (event: Event) => { if (host.shown() && !(event.target instanceof Node && host.card()?.contains(event.target))) host.hide(); };
  document.addEventListener("pointerover", onOver);
  document.addEventListener("pointerout", onOut);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", endPress);
  document.addEventListener("pointercancel", endPress);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  return () => {
    disarm();
    clearTimeout(leave);
    endPress();
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", endPress);
    document.removeEventListener("pointercancel", endPress);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onScroll, true);
  };
}
