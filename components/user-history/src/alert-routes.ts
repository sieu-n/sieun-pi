export interface AlertRoute { chat: string; session: string; words: readonly string[] }

export const OPS_ROUTE: AlertRoute = { chat: "ops guy", session: "01a11af8-962e-773d-a19a-ee4104011987", words: ["local dev", "box"] };

export const ALERT_ROUTES: readonly AlertRoute[] = [
  { chat: "Crawler VP", session: "01a115e2-9544-7204-b8db-8ce4d5319048", words: ["crawler", "census"] },
  { chat: "VP of CI", session: "01a1180e-6567-747f-bf44-452520ebdd1b", words: ["ci", "runner"] },
  { chat: "launch main bro", session: "01a11bd7-072f-7591-ad1d-f123c276cde5", words: ["launch", "watchlist"] },
  { chat: "api portal vp", session: "01a1301d-18de-7129-a559-cfb92f9b5fb1", words: ["api portal"] },
  { chat: "slack green guy", session: "01a11b0b-7c15-73da-9481-8de15903eab4", words: ["slack green"] },
  OPS_ROUTE,
];

const tokens = (text: string): string => ` ${text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ")} `;

export function routeAlert(texts: readonly string[], routes: readonly AlertRoute[] = ALERT_ROUTES): AlertRoute {
  const said = texts.map(tokens);
  return routes.find(route => route.words.some(word => said.some(text => text.includes(` ${word} `)))) ?? OPS_ROUTE;
}
