/** The one timer for the whole page. It ticks once a second while the tab is visible and stops while it is hidden. */
class Clock {
  now = $state(Date.now());
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    document.addEventListener("visibilitychange", () => this.sync());
    this.sync();
  }

  private sync(): void {
    if (document.visibilityState === "visible") {
      this.now = Date.now();
      this.timer ??= setInterval(() => { this.now = Date.now(); }, 1000);
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export const clock = new Clock();

/** Every spinner runs on the document timeline from time zero, so all of them turn in the same phase however late each one mounted. */
export function syncSpinners(): () => void {
  const align = (event: AnimationEvent) => {
    if (event.animationName !== "spin" || !(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations()) if (animation instanceof CSSAnimation && animation.animationName === "spin") animation.startTime = 0;
  };
  document.addEventListener("animationstart", align, true);
  return () => document.removeEventListener("animationstart", align, true);
}
