import type { ExtensionAPI } from "prime-agent";
import { collectHistory } from "../src/history.ts";
import { renderPage } from "../src/page.ts";
import { oneShotPage } from "../src/delivery.ts";
import { registerChatCommand } from "./chat.ts";

export default function historyExtension(pi: ExtensionAPI, asideExecutable = "/usr/bin/open"): void {
  registerChatCommand(pi, asideExecutable);
  pi.registerCommand("what-did-i-say", {
    description: "Read saved questions and final responses in Aside",
    async handler(_args, ctx) {
      const snapshot = collectHistory(ctx.sessionManager.getBranch());
      const delivery = await oneShotPage(renderPage(snapshot));
      try {
        const opened = await pi.exec(asideExecutable, ["-b", "at.studio.AsideBrowser", delivery.url], { timeout: 30000 });
        if (opened.code !== 0 || opened.killed) {
          ctx.ui.notify("Aside could not open the snapshot. This command requires macOS and the Aside app.", "error");
          return;
        }
        const status = await delivery.closed;
        ctx.ui.notify(status === "consumed"
          ? "Opened saved questions and final responses in Aside."
          : "The snapshot was not delivered before the local listener closed. Run /what-did-i-say again.",
        status === "consumed" ? "info" : "warning");
      } finally {
        delivery.close();
      }
    },
  });
}
