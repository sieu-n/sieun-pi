/**
 * The owner's standing go on production moves, one switch for every place that asks for his go on a merge (c49). While `preapproval` is
 * set, a prod promote, a PR merge or a push to main or master needs no For you todo: the board gate (`needsGo` in chat-board.ts), the
 * global-rules merge guard and the briefs pass it, and a todo that asks for such a go is refused. An outside send (c37) and a public release
 * keep their todo. When an owner rule after launch takes the standing go back, set `preapproval` to null and the c49 gate returns everywhere.
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
