import { checkinGoalPush } from "./checkin-goal-push.ts";
import { carriedRelease, carriedWait } from "./carried-wait.ts";
import { unrelatedCiControlled } from "./unrelated-ci-controlled.ts";
import { unrelatedCiWait } from "./unrelated-ci-wait.ts";
import { checkinJobSteer } from "./checkin-job-steer.ts";
import { checkinPushControl } from "./checkin-push-control.ts";
import { chatToolsReopen } from "./chat-tools-reopen.ts";
import { reopenFirstMessage } from "./reopen-first-message.ts";
import { boxBrowserDefault } from "./box-browser-default.ts";
import { boxTools } from "./box-tools.ts";
import { checkinRealTask } from "./checkin-real-task.ts";
import { detachedReport } from "./detached-report.ts";
import { relativeDuty } from "./relative-duty.ts";
import { correctionRefine } from "./correction-refine.ts";
import { dmReplies } from "./dm-replies.ts";
import { englishJobs } from "./english-jobs.ts";
import { everydayTask } from "./everyday-task.ts";
import { quietWakes } from "./quiet-wakes.ts";
import { historyLeftovers } from "./history-leftovers.ts";
import { holdAsk } from "./hold-ask.ts";
import { machineBranch } from "./machine-branch.ts";
import { sharedShapes } from "./shared-shapes.ts";
import { layoutPick } from "./layout-pick.ts";
import { chatWebParts } from "./chat-web-parts.ts";
import { designPage } from "./design-page.ts";
import { idleUnload } from "./idle-unload.ts";
import { importSpeed } from "./import-speed.ts";
import { kernelRevive } from "./kernel-revive.ts";
import { lostBrief } from "./lost-brief.ts";
import { lostBriefModel } from "./lost-brief-model.ts";
import { oldCommitTests } from "./old-commit-tests.ts";
import { jobCancelCleanup } from "./job-cancel-cleanup.ts";
import { ordinaryHour } from "./ordinary-hour.ts";
import { readmePreview } from "./readme-preview.ts";
import { savedLogin } from "./saved-login.ts";
import { ownerAsks } from "./owner-asks.ts";
import { plainWords } from "./plain-words.ts";
import { planAndDuties } from "./plan-and-duties.ts";
import { taskAndUpkeep } from "./task-and-upkeep.ts";
import { softCaps } from "./soft-caps.ts";
import { stepIds } from "./step-ids.ts";
import { tokenHookResume } from "./token-hook-resume.ts";
import { wakeLive } from "./wake-live.ts";
import { transcriptBoundary } from "./transcript-boundary.ts";
import { publishedBuildKeep } from "./published-build-keep.ts";
import { taskOwner } from "./task-owner.ts";
import { answerData } from "./answer-data.ts";
import { tokenCost } from "./token-cost.ts";
import { dryMessage } from "./dry-message.ts";
import { resumeModel } from "./resume-model.ts";
import { waitingSession } from "./waiting-session.ts";
import { ownerView } from "./owner-view.ts";
import type { Scenario } from "./session-read.ts";

/** Every clean-room scenario by the name `clean-room.ts setup --scenario` takes. */
export const SCENARIOS: Record<string, Scenario> = { "carried-release": carriedRelease, "carried-wait": carriedWait, "checkin-goal-push": checkinGoalPush, "checkin-real-task": checkinRealTask, "checkin-push-control": checkinPushControl, "correction-refine": correctionRefine, "dm-replies": dmReplies, "english-jobs": englishJobs, "everyday-task": everydayTask, "quiet-wakes": quietWakes, "import-speed": importSpeed,
  "checkin-job-steer": checkinJobSteer, "token-cost": tokenCost, "chat-tools-reopen": chatToolsReopen, "reopen-first-message": reopenFirstMessage, "kernel-revive": kernelRevive, "lost-brief": lostBrief, "lost-brief-model": lostBriefModel, "ordinary-hour": ordinaryHour, "idle-unload": idleUnload, "owner-asks": ownerAsks, "plan-and-duties": planAndDuties, "task-and-upkeep": taskAndUpkeep, "soft-caps": softCaps, "step-ids": stepIds, "token-hook-resume": tokenHookResume, "wake-live": wakeLive, "box-browser-default": boxBrowserDefault, "box-tools": boxTools,
  "detached-report": detachedReport, "relative-duty": relativeDuty, "old-commit-tests": oldCommitTests, "readme-preview": readmePreview, "history-leftovers": historyLeftovers, "hold-ask": holdAsk, "machine-branch": machineBranch, "shared-shapes": sharedShapes, "layout-pick": layoutPick, "chat-web-parts": chatWebParts, "design-page": designPage, "plain-words": plainWords, "saved-login": savedLogin , "job-cancel-cleanup": jobCancelCleanup,
  "transcript-boundary": transcriptBoundary, "published-build-keep": publishedBuildKeep, "task-owner": taskOwner, "answer-data": answerData, "dry-message": dryMessage, "resume-model": resumeModel, "waiting-session": waitingSession, "unrelated-ci-wait": unrelatedCiWait, "unrelated-ci-controlled": unrelatedCiControlled, "owner-view": ownerView };
