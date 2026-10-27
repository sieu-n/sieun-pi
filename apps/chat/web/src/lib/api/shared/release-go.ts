/**
 * The owner's standing go on production moves (c74), which c154 narrows for prod deploys (`narrowedBy`). While `preapproval` is set, a PR
 * merge or a push to main or master needs no For you todo: the briefs say so, and the check-in does not count such a step as waiting for his
 * go. An outside send (c37) and a public release keep their todo. When an owner rule after launch takes the standing go back, set `preapproval` to null and the briefs carry the c49 text.
 */
export interface PreApproval { readonly rule: string; readonly date: string; readonly words: string; readonly narrowedBy?: string }

export const C74: PreApproval = {
  rule: "c74",
  date: "2026-10-15",
  words: "Until the proper launch, the owner pre-approves every prod promote, merge or push to main. Never put a promote, merge or push go on " +
    "For you and never wait for one; the release owner promotes as soon as staging checks out.",
  narrowedBy: "Owner rule c154 (2026-10-22) narrows it for prod deploys: a job's work ends at staging, the release owner walks each prod promote " +
    "with the owner, and a step that waits on his answer to a prod deploy todo is waiting on him, so never close that todo or ship that deploy " +
    "without his answer. Only crawler, observability dashboard and demo.virev.ai deploys still ship to prod without him.",
};

export const releaseGo: { preapproval: PreApproval | null } = { preapproval: C74 };

/**
 * The standing go in the words of its rule, with its id and date, and the later rule that narrows it. On 10-25 the Vent gateway duty told its
 * chat to close the owner's prod deploy todo t15 and ship prod Vent itself under c74, because no brief named c154.
 */
export const preApprovalText = (preapproval: PreApproval): string =>
  `Owner rule ${preapproval.rule} (${preapproval.date}): ${preapproval.words}` + (preapproval.narrowedBy ? ` ${preapproval.narrowedBy}` : "");
