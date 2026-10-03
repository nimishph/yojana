import type { Claim, Plan, Requirement } from '@cntxt-labs/yojana-core';

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

/** `expect` is written only when false: true is the default, and authors leave it out. */
function renderClaim(claim: Claim): string {
  return [
    '```yojana:claim',
    `kind: ${yamlString(claim.kind)}`,
    `expression: ${yamlString(claim.expression)}`,
    ...(claim.expect ? [] : ['expect: false']),
    '```',
  ].join('\n');
}

function renderRequirement(requirement: Requirement): string {
  const work = requirement.workItems ?? [];
  const links = work.length > 0 ? ` beads=${work.join(',')}` : '';
  const blocks = [`## Requirement: ${requirement.title} {#${requirement.id}${links}}`];
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
