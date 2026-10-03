// Engine facade: composes the ports into ingest, status, archive and check. See docs/design.md.
export const VERSION = '0.0.0';

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
  ensureGitAttributes,
  loadPlanFiles,
  openWorkspace,
  settleChangeFile,
  type Workspace,
} from './workspace.ts';
