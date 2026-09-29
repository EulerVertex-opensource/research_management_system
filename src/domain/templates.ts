/** Starting files for nodes created from the dashboard. Forward relations only; reverse ones are derived. */
const statementTemplate = (type: string, placeholder: string, sourceKind: 'paper' | 'original' | undefined) => `---
type: ${type}
title: {title}
status: draft
${sourceKind === 'paper' ? 'source:\n  kind: paper\n  paper_id: ""\n  location: ""\n' : sourceKind ? `source:\n  kind: ${sourceKind}\n` : ''}depends_on: []
uses_definitions: []
tags: []
---

${placeholder}
`;

const NODE_TEMPLATES: Record<string, string> = {
  theorem: statementTemplate('theorem', 'Write the theorem statement here.', 'paper'),
  lemma: statementTemplate('lemma', 'Write the lemma statement here.', 'paper'),
  proposition: statementTemplate('proposition', 'Write the proposition statement here.', 'paper'),
  example: statementTemplate('example', 'Describe the example here.', 'original'),
  construction: statementTemplate('construction', 'Describe the construction here.', 'original'),
  remark: statementTemplate('remark', 'Write the remark here.', undefined),
  definition: `---
type: definition
title: {title}
status: draft
source:
  kind: original
depends_on: []
tags: []
---

Write the defining statement and the notation it introduces here.
`,
  plan: `---
type: plan
title: {title}
status: pending
target_asset: {target_asset}
inspired_by: []
tags: []
---

## Goal

Target: [asset]({target_link})

Prove the claim stated in the target asset.

## Plan

1. [ ] Describe the first mathematical step.

## Verification

Explain how to check that the steps prove the asset's statement.
`,
  idea: `---
type: idea
title: {title}
status: draft
idea_kind: approach
related_assets: []
tags: []
---

Describe the intuition, possible approach, open question, or test case here.
`,
};

export function nodeTemplate(type: string, fields: { title: string; targetAsset?: string; targetLink?: string }): string {
  const template = NODE_TEMPLATES[type] ?? NODE_TEMPLATES.remark;
  return template
    .replace('{title}', JSON.stringify(fields.title))
    .replace(/\{target_link\}/g, fields.targetLink ?? '')
    .replace(/\{target_asset\}/g, fields.targetAsset ?? '');
}
