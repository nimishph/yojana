// Engine facade: composes the ports into ingest, status, archive and check. See docs/design.md.
export const VERSION = '0.0.0';

export { type ImportReport, importAndValidate } from '@cntxt-labs/yojana-markdown';
export {
  type AbandonResult,
  type ArchiveResult,
  abandonChange,
  applyChange,
  archiveChange,
  type ChangeProblem,
  type OpenChangeResult,
  openChange,
  type PlanFileUpdate,
} from './changes.ts';
export { type CheckReport, check, type PlanCheck } from './check.ts';
export {
  type CommentResult,
  comment,
  type RemoveCommentResult,
  removeComment,
} from './comment.ts';
export {
  type AppliedDecision,
  applyDecisions,
  type DecisionRequest,
  type DecisionResult,
  finalizeDecision,
  recordDecision,
} from './decisions.ts';
export { type EditFailure, type EditRequest, editRequirement, suggestEdit } from './edit.ts';
export {
  type FileReport,
  type IngestOptions,
  type IngestReport,
  ingest,
  type Movement,
  movement,
  type PlanFile,
  type RequirementOutcome,
  type StatusOutcome,
} from './ingest.ts';
export {
  type ApprovalResult,
  approveRequirement,
  declineRequirement,
  declineStatus,
  finalizeStatus,
  type ProposalResult,
  proposeStatus,
  settleStatusLine,
} from './plan-status.ts';
export { type ItemProgress, type PlanProgress, progress } from './progress.ts';
export {
  ACTIVITY_LIMIT,
  AGENT_ACTORS,
  ago,
  type ProjectOptions,
  projectReview,
  type ReviewActivity,
  type ReviewChange,
  type ReviewDocument,
  type ReviewSection,
  type ReviewThread,
} from './project.ts';
export { type RefreshedFile, type RefreshReport, refresh } from './refresh.ts';
export {
  REVIEW_TEMPLATE,
  type ReviewAnswer,
  type ReviewIntent,
  type ReviewSession,
  type ReviewSessionOptions,
  reviewSession,
} from './session.ts';
export {
  type FileState,
  type OpenChange,
  type PlanReport,
  type StatusReport,
  status,
} from './status.ts';
export {
  ensureGitAttributes,
  loadPlanFiles,
  openWorkspace,
  settleChangeFile,
  type Workspace,
} from './workspace.ts';
