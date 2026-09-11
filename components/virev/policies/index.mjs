import * as autoSnsAgent from "./auto-sns-agent/index.mjs";

export function policyFor(name) {
  return name === "auto-sns-agent" ? autoSnsAgent : null;
}
