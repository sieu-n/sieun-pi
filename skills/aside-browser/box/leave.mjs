// A box tab's goto and reload first wait for the page's unanswered Convex mutations, because the Convex server drops a write it
// was retrying once the page's socket closes: two staging walks' page.goto lost an askCount write each at 18:12Z and 18:21Z
// on 11-09. virev's app pages expose window.__convexWritesLanded (WRITES_LANDED_KEY in auto-sns-agent
// apps/search/src/lib/convex/leave.ts). The wait ends as auto-sns-agent 7e66e5964's e2e writesLanded does, and also once no
// Convex sync socket of the page is open, since a write waits for the socket to come back and a socket that stays down
// held the old wait, and with it the whole runner, forever.
const LANDED_KEY = "__convexWritesLanded";
// The e2e write guard's idle function (SOCKET_GUARD_IDLE_KEY in apps/search/tests/e2e/helpers/staging-writes.ts): a
// mutation the guard dropped never answers, so the page's own wait never ends.
const GUARD_IDLE_KEY = "__socketGuardIdle";
const LEAVING = /Execution context was destroyed|Target page, context or browser has been closed/;

const isSync = (url) => {
  try {
    const { pathname } = new URL(url);
    return pathname.startsWith("/api/") && pathname.endsWith("/sync");
  } catch {
    return false;
  }
};

function pageWrites([landedKey, idleKey]) {
  const landed = window[landedKey]?.();
  const idle = window[idleKey]?.();
  return landed && idle ? Promise.race([landed, idle]) : landed;
}

/** Wraps `p.goto` and `p.reload` so each first waits for the page's mutations, and returns `p`. */
export function holdLeaves(p) {
  const open = new Set();
  const down = new Set();
  p.on("websocket", (ws) => {
    if (!isSync(ws.url())) return;
    open.add(ws);
    const gone = () => {
      open.delete(ws);
      if (open.size === 0) for (const resolve of down) resolve();
    };
    ws.on("close", gone);
    ws.on("socketerror", gone);
  });
  async function writesLanded() {
    if (open.size === 0) return;
    let resolve;
    const socketDown = new Promise((r) => down.add((resolve = r)));
    const landed = p.evaluate(pageWrites, [LANDED_KEY, GUARD_IDLE_KEY]).then(() => null, (e) => e);
    const error = await Promise.race([landed, socketDown.then(() => null)]);
    down.delete(resolve);
    if (error && !LEAVING.test(String(error))) throw error;
  }
  for (const name of ["goto", "reload"]) {
    const leave = p[name].bind(p);
    p[name] = async (...args) => {
      await writesLanded();
      return leave(...args);
    };
  }
  return p;
}
