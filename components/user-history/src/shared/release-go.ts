/**
 * The owner's standing go on production moves (c74). While `preapproval` is set, a prod promote, a PR merge or a push to main or master needs no
 * For you todo: the briefs say so, and the check-in does not count such a step as waiting for his go. An outside send (c37) and a public release
 * keep their todo. When an owner rule after launch takes the standing go back, set `preapproval` to null and the briefs carry the c49 text.
 */
export interface PreApproval { readonly rule: string; readonly date: string; readonly words: string }

export const C74: PreApproval = {
  rule: "c74",
  date: "2026-10-15",
  words: "Until the proper launch, the owner pre-approves every prod promote, merge or push to main. Never put a promote, merge or push go on " +
    "For you and never wait for one; the release owner promotes as soon as staging checks out.",
};

export const releaseGo: { preapproval: PreApproval | null } = { preapproval: C74 };

/** The standing go in the words of its rule, with its id and date. */
export const preApprovalText = (preapproval: PreApproval): string => `Owner rule ${preapproval.rule} (${preapproval.date}): ${preapproval.words}`;
