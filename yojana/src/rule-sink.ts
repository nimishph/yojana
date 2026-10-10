import {
  foldLog,
  type RuleProposal,
  type RuleProposalResult,
  type RuleSinkPort,
  requirementWorkItems,
  type StorePort,
  type WorkLinkPort,
} from '@cntxt-labs/yojana-core';
import type { CheckReport } from './check.ts';

export interface ProposeRulesOptions {
  readonly store: StorePort;
  readonly checkReport: CheckReport;
  readonly ruleSink: RuleSinkPort;
  readonly worklink?: WorkLinkPort | undefined;
  readonly planId?: string | undefined;
  readonly requirementId?: string | undefined;
  readonly actor: string;
  readonly dryRun?: boolean | undefined;
}

export interface RuleProposalEntry {
  readonly planId: string;
  readonly requirementId: string;
  readonly actionId?: string | undefined;
  readonly proposal: RuleProposal;
  readonly result?: RuleProposalResult | undefined;
}

export interface RuleSkippedEntry {
  readonly planId: string;
  readonly requirementId: string;
  readonly reason: string;
}

export interface ProposeRulesReport {
  readonly proposed: readonly RuleProposalEntry[];
  readonly skipped: readonly RuleSkippedEntry[];
}

/**
 * Identifies realized requirements whose claims hold, and proposes their decisions
 * (and action items) to the RuleSink (e.g. MedhaRuleSink).
 */
export async function proposeRules(options: ProposeRulesOptions): Promise<ProposeRulesReport> {
  const state = foldLog(await options.store.events());
  const proposedEntries: Array<{
    planId: string;
    requirementId: string;
    actionId?: string | undefined;
    proposal: RuleProposal;
  }> = [];
  const skipped: RuleSkippedEntry[] = [];

  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId) continue;

    const planCheck = options.checkReport.plans.find((p) => p.planId === plan.id);
    const results = planCheck?.results ?? [];

    let itemsById = new Map<string, { id: string; state: string }>();
    if (options.worklink !== undefined) {
      const allWorkItems = [
        ...new Set(
          Array.from(plan.heads.values()).flatMap((r) => [
            ...requirementWorkItems(r),
            ...(r.actions ?? []).flatMap((a) => a.workItems ?? []),
          ]),
        ),
      ];
      if (allWorkItems.length > 0) {
        const lookup = await options.worklink.get(allWorkItems);
        if (lookup.ok) {
          itemsById = new Map(lookup.items.map((i) => [i.id, i]));
        }
      }
    }

    for (const req of plan.heads.values()) {
      if (options.requirementId !== undefined && req.id !== options.requirementId) continue;

      const ownResults = results.filter((r) => r.requirement === req.id && r.action === undefined);
      const actResults = results.filter((r) => r.requirement === req.id && r.action !== undefined);
      const totalClaims =
        req.claims.length + (req.actions ?? []).reduce((n, a) => n + (a.claims ?? []).length, 0);

      if (totalClaims === 0) {
        skipped.push({
          planId: plan.id,
          requirementId: req.id,
          reason: 'requirement has no claims to prove it',
        });
        continue;
      }

      const allHold =
        ownResults.length === req.claims.length &&
        ownResults.every((r) => r.outcome === 'holds') &&
        (req.actions ?? []).every((act) => {
          const actClaims = act.claims ?? [];
          const actOwn = actResults.filter((r) => r.action === act.id);
          return actOwn.length === actClaims.length && actOwn.every((r) => r.outcome === 'holds');
        });

      if (!allHold) {
        skipped.push({
          planId: plan.id,
          requirementId: req.id,
          reason: 'claims do not all hold',
        });
        continue;
      }

      // Check whether realized
      const planRealized = plan.status === 'realized';
      const reqItems = requirementWorkItems(req).map((id) => itemsById.get(id));
      const hasReqItems = reqItems.length > 0;
      const allReqItemsClosed = hasReqItems && reqItems.every((i) => i?.state === 'closed');

      const actItems = (req.actions ?? []).flatMap((a) =>
        (a.workItems ?? []).map((id) => itemsById.get(id)),
      );
      const hasActItems = actItems.length > 0;
      const allActItemsClosed = !hasActItems || actItems.every((i) => i?.state === 'closed');

      const isRealized = planRealized || (allReqItemsClosed && allActItemsClosed);

      if (!isRealized) {
        skipped.push({
          planId: plan.id,
          requirementId: req.id,
          reason: 'requirement or plan is not realized (work items open or plan not realized)',
        });
        continue;
      }

      // Eligible: construct proposals
      const claimEvidences = [...ownResults, ...actResults].map((r) => r.evidence).filter(Boolean);
      const evidenceStr = claimEvidences.join('; ');

      const reqProposal: RuleProposal = {
        id: req.id,
        kind: 'rule',
        source: plan.id,
        text: `${req.title}\n\n${req.text}`.trim(),
        evidence: evidenceStr !== '' ? evidenceStr : undefined,
        author: options.actor,
        note: `Realized requirement ${req.id} in ${plan.id} (${totalClaims} claims hold)`,
      };

      proposedEntries.push({
        planId: plan.id,
        requirementId: req.id,
        proposal: reqProposal,
      });

      // Actions under requirement
      for (const act of req.actions ?? []) {
        const actOwnResults = actResults.filter((r) => r.action === act.id);
        const actEvidence = actOwnResults
          .map((r) => r.evidence)
          .filter(Boolean)
          .join('; ');

        const actProposal: RuleProposal = {
          id: `${req.id}:${act.id}`,
          kind: 'rule',
          source: plan.id,
          text: act.text,
          evidence: actEvidence !== '' ? actEvidence : undefined,
          author: options.actor,
          note: `Action item ${act.id} from realized requirement ${req.id} in ${plan.id}`,
        };

        proposedEntries.push({
          planId: plan.id,
          requirementId: req.id,
          actionId: act.id,
          proposal: actProposal,
        });
      }
    }
  }

  if (options.dryRun || proposedEntries.length === 0) {
    return {
      proposed: proposedEntries,
      skipped,
    };
  }

  const proposalList = proposedEntries.map((e) => e.proposal);
  const results = await options.ruleSink.propose(proposalList);
  const resultsById = new Map(results.map((r) => [r.id, r]));

  const finalProposed = proposedEntries.map((e) => ({
    ...e,
    result: resultsById.get(e.proposal.id),
  }));

  return {
    proposed: finalProposed,
    skipped,
  };
}
