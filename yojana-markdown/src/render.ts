import type { Claim, Plan, Requirement } from '@cntxt-labs/yojana-core';

const PLAIN_SCALAR = /^[A-Za-z0-9/][A-Za-z0-9 ._/()-]*$/;
const YAML_KEYWORD = /^(true|false|null|yes|no|on|off|~|[-+]?[\d._]+)$/i;

/** A YAML scalar that reads back as the same string: plain when safe, quoted otherwise. */
function yamlString(value: string): string {
  if (value.includes('\n')) return JSON.stringify(value);
  if (PLAIN_SCALAR.test(value) && !YAML_KEYWORD.test(value) && !value.endsWith(' ')) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

function renderClaim(claim: Claim): string {
  return [
    '```yojana:claim',
    `kind: ${yamlString(claim.kind)}`,
    `expression: ${yamlString(claim.expression)}`,
    `expect: ${claim.expect}`,
    '```',
  ].join('\n');
}

function renderRequirement(requirement: Requirement): string {
  const blocks = [`## Requirement: ${requirement.title} {#${requirement.id}}`];
  if (requirement.text !== '') blocks.push(requirement.text);
  for (const claim of requirement.claims) blocks.push(renderClaim(claim));
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
