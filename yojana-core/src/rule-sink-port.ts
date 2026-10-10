/**
 * RuleSinkPort: proposes proven architectural decisions to a rules engine (e.g. medha).
 * When a requirement is realized and its claims hold in the codebase, its decision
 * and action items can be proposed as probation rules.
 */

export interface RuleProposal {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly namespace?: string | undefined;
  readonly text?: string | undefined;
  readonly source: string;
  readonly evidence?: string | undefined;
  readonly author?: string | undefined;
  readonly at?: number | string | undefined;
  readonly note?: string | undefined;
}

export interface RuleProposalResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly entity?: unknown | undefined;
}

export interface RuleSinkPort {
  readonly name: string;
  propose(proposals: readonly RuleProposal[]): Promise<readonly RuleProposalResult[]>;
}
