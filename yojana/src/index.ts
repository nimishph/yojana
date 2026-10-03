// Engine facade: composes the ports into ingest, status, archive and check. See docs/design.md.
export const VERSION = '0.0.0';

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
export { loadPlanFiles, openWorkspace, type Workspace } from './workspace.ts';
