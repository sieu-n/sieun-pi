import { SessionManager } from "prime-agent";
import { collectHistory } from "../src/history.ts";
import { renderPage } from "../src/page.ts";
import { oneShotPage } from "../src/delivery.ts";
import { populateHistory } from "../test/native-fixture.ts";

const manager = SessionManager.inMemory("/synthetic-history-preview");
populateHistory(manager);
const delivery = await oneShotPage(renderPage(collectHistory(manager.getBranch())));
process.stdout.write(JSON.stringify({ url: delivery.url, synthetic: true, expiresAfterMs: 30000 }) + "\n");
const close = () => delivery.close();
process.once("SIGTERM", close);
process.once("SIGINT", close);
const status = await delivery.closed;
process.removeListener("SIGTERM", close);
process.removeListener("SIGINT", close);
process.stdout.write(JSON.stringify({ status }) + "\n");
