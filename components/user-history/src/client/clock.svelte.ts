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

