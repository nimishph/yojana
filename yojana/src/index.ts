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
export { type CommentResult, comment } from './comment.ts';
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
export { type ItemProgress, type PlanProgress, progress } from './progress.ts';
export { type RefreshedFile, type RefreshReport, refresh } from './refresh.ts';
export { escapeHtml, renderMarkdown, review } from './review.ts';
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
