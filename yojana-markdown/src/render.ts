import type { Action, ChangeDraft, Claim, Plan, Requirement } from '@cntxt-labs/yojana-core';

/**
 * A YAML scalar that reads back as the same string. Plain whenever the YAML parser gives the value
 * back unchanged (so `//file[@path="x"]` stays as its author wrote it), quoted otherwise.
 */
function yamlString(value: string): string {
  if (value.includes('\n')) return JSON.stringify(value);
  const quoted = `'${value.replaceAll("'", "''")}'`;
  if (value === '' || value !== value.trim()) return quoted;
  try {
    const back: unknown = Bun.YAML.parse(`v: ${value}`);
    const plainWorks = typeof back === 'object' && back !== null && 'v' in back && back.v === value;
    return plainWorks ? value : quoted;
  } catch {
    return quoted;
  }
}

function renderYamlMapping(obj: Record<string, unknown>, indent = ''): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        lines.push(
          `${indent}${key}: [${value.map((v) => (typeof v === 'string' ? yamlString(v) : JSON.stringify(v))).join(', ')}]`,
        );
      } else {
        lines.push(`${indent}${key}:`);
        lines.push(...renderYamlMapping(value as Record<string, unknown>, `${indent}  `));
      }
    } else if (typeof value === 'string') {
      lines.push(`${indent}${key}: ${yamlString(value)}`);
    } else {
      lines.push(`${indent}${key}: ${value}`);
    }
  }
  return lines;
}

function renderClaimBody(claim: Claim, indent = ''): string[] {
  const lines: string[] = [`${indent}kind: ${yamlString(claim.kind)}`];
  if (claim.expression !== undefined && claim.expression.trim() !== '') {
    lines.push(`${indent}expression: ${yamlString(claim.expression)}`);
  }
  if (claim.params !== undefined && Object.keys(claim.params).length > 0) {
    lines.push(...renderYamlMapping(claim.params as Record<string, unknown>, indent));
  }
  if (claim.claims !== undefined && claim.claims.length > 0) {
    if (claim.kind === 'not' && claim.claims.length === 1 && claim.claims[0] !== undefined) {
      lines.push(`${indent}claim:`);
      lines.push(...renderClaimBody(claim.claims[0], `${indent}  `));
    } else {
      lines.push(`${indent}claims:`);
      for (const child of claim.claims) {
        const childLines = renderClaimBody(child, `${indent}    `);
        if (childLines.length > 0 && childLines[0] !== undefined) {
          lines.push(`${indent}  - ${childLines[0].trimStart()}`);
          for (const remaining of childLines.slice(1)) {
            lines.push(remaining);
          }
        }
      }
    }
  }
  if (claim.expect === false) {
    lines.push(`${indent}expect: false`);
  } else if (typeof claim.expect === 'object' && claim.expect !== null) {
    lines.push(`${indent}expect:`);
    lines.push(...renderYamlMapping(claim.expect as Record<string, unknown>, `${indent}  `));
  }
  return lines;
}

/** `expect` is written only when not true: true is the default, and authors leave it out. */
function renderClaim(claim: Claim): string {
  const lines = ['```yojana:claim', ...renderClaimBody(claim), '```'];
  return lines.join('\n');
}

function renderAction(action: Action): string {
  const work = action.workItems ?? [];
  const links =
    work.length === 1 ? ` bead=${work[0]}` : work.length > 1 ? ` beads=${work.join(',')}` : '';
  const lines = [`- ${action.text} {#${action.id}${links}}`];
  if (action.claims !== undefined && action.claims.length > 0) {
    for (const claim of action.claims) lines.push(renderClaim(claim));
  }
  return lines.join('\n');
}

function renderRequirement(requirement: Requirement, marker = ''): string {
  const work = requirement.workItems ?? [];
  const links = work.length > 0 ? ` beads=${work.join(',')}` : '';
  const blocks = [`## ${marker}Requirement: ${requirement.title} {#${requirement.id}${links}}`];
  if (requirement.text !== '') blocks.push(requirement.text);
  for (const claim of requirement.claims) blocks.push(renderClaim(claim));
  if (requirement.actions !== undefined && requirement.actions.length > 0) {
    blocks.push(`### Actions\n\n${requirement.actions.map(renderAction).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** Render a plan back to the Markdown format that `parsePlan` reads. */
export function renderPlan(plan: Plan): string {
  const byId = new Map(plan.requirements.map((r) => [r.id, r]));
  const frontmatter = [
    '---',
    `id: ${yamlString(plan.id)}`,
    `title: ${yamlString(plan.title)}`,
    `status: ${plan.status}`,
    `beads: [${plan.workItems.map(yamlString).join(', ')}]`,
    '---',
  ].join('\n');

  const blocks = [frontmatter, `# ${plan.title}`];
  for (const part of plan.parts) {
    if (part.kind === 'prose') {
      blocks.push(part.markdown);
      continue;
    }
    const requirement = byId.get(part.id);
    if (requirement !== undefined) blocks.push(renderRequirement(requirement));
  }
  // Requirements not placed by `parts` (a plan built in code) still render, after the rest.
  const placed = new Set(plan.parts.flatMap((p) => (p.kind === 'requirement' ? [p.id] : [])));
  for (const requirement of plan.requirements) {
    if (!placed.has(requirement.id)) blocks.push(renderRequirement(requirement));
  }
  return `${blocks.join('\n\n')}\n`;
}

/** Render a change file in the format that `parseChange` reads. */
export function renderChange(change: ChangeDraft, why?: string): string {
  const frontmatter = [
    '---',
    `id: ${yamlString(change.id)}`,
    `plan: ${yamlString(change.planId)}`,
    `title: ${yamlString(change.title)}`,
    '---',
  ].join('\n');
  const blocks = [frontmatter];
  if (why !== undefined && why.trim() !== '') blocks.push(why.trim());
  for (const delta of change.deltas) {
    if (delta.op === 'remove') blocks.push(`## REMOVED Requirement: ${delta.id} {#${delta.id}}`);
    else
      blocks.push(
        renderRequirement(delta.requirement, delta.op === 'add' ? 'ADDED ' : 'MODIFIED '),
      );
  }
  return `${blocks.join('\n\n')}\n`;
}
