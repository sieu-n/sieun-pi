export interface AlertRoute { chat: string; session: string; words: readonly string[] }

/**
 * The default route, and the chat every escalation, boardless tell, bridge watchdog line and uptime page goes to: devops guy, the sw factory
 * agent ag_devops-guy, whose work thread is a pi-host thread. The owner moved ops guy's and the VP of CI's work to it on 11-26 (t10, mwwlt2rm):
 * "Yes, and the VP of CI hands over CI too".
 */
export const OPS_ROUTE: AlertRoute = { chat: "devops guy", session: "76b58e4d-b23b-49f9-aa73-625b4bbcdd64", words: ["local dev", "box"] };

export const ALERT_ROUTES: readonly AlertRoute[] = [
  { chat: "Crawler VP", session: "01a115e2-9544-7204-b8db-8ce4d5319048", words: ["crawler", "census"] },
  { chat: "devops guy", session: OPS_ROUTE.session, words: ["ci", "runner"] },
  { chat: "launch main bro", session: "01a11bd7-072f-7591-ad1d-f123c276cde5", words: ["launch", "watchlist"] },
  { chat: "api portal vp", session: "01a1301d-18de-7129-a559-cfb92f9b5fb1", words: ["api portal"] },
  { chat: "slack green guy", session: "01a11b0b-7c15-73da-9481-8de15903eab4", words: ["slack green"] },
  { chat: "AI harness developer environment VP", session: "01a1164b-4a2d-742d-b27a-82f086ed0200", words: ["pi pool"] },
  OPS_ROUTE,
];

const tokens = (text: string): string => ` ${text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ")} `;

export function routeAlert(texts: readonly string[], routes: readonly AlertRoute[] = ALERT_ROUTES): AlertRoute {
  const said = texts.map(tokens);
  return routes.find(route => route.words.some(word => said.some(text => text.includes(` ${word} `)))) ?? OPS_ROUTE;
}
