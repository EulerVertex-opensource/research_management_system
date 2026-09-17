export interface ResearchWorkflow {
  label: string;
  purpose: string;
  instructions: string;
}

/**
 * Dashboard prompt templates. Bundled skills in `skills/` provide the
 * corresponding procedures for repository agents.
 */
export const RESEARCH_WORKFLOWS: Record<string, ResearchWorkflow> = {
  extract_theorems: {
    label: 'Extract theorem nodes from paper notes',
    purpose: 'Turn a paper transcription or notes into provenance-preserving draft research nodes.',
    instructions: `From the notes or paper excerpt below, extract all theorem-like results (theorems, lemmas, propositions, definitions, examples).

For each result, provide:
- Suggested node id (snake_case, descriptive)
- Type: theorem | lemma | proposition | definition | example
- Title
- Statement (verbatim or paraphrased)
- Source: theorem number or location in the paper
- Dependencies (other results this relies on, if known)
- Suggested tags (mathematical area keywords)
- Status: draft

Format each result as a Markdown code block with YAML frontmatter.

Notes/excerpt:
`,
  },

  plan_section: {
    label: 'Plan a paper section',
    purpose: 'Plan a manuscript section from approved results and relevant ideas.',
    instructions: `Using the approved research nodes and ideas provided as context, suggest a detailed outline for a paper section.

For each subsection, indicate:
- What to prove or explain
- Which theorems/lemmas are needed (reference by node id)
- Suggested order of presentation
- Any gaps or missing intermediate results

Section topic:
`,
  },

  draft_latex: {
    label: 'Draft LaTeX from approved nodes',
    purpose: 'Draft manuscript LaTeX grounded in approved research nodes.',
    instructions: `Write a LaTeX section draft using the theorem/lemma nodes provided in context.

Rules:
1. Follow all configured macro and preamble files — do not introduce new \\newcommand without checking them.
2. Follow the configured notation file when present — do not change notation silently.
3. Use the theorem and proof environments defined by the project.
4. Reference theorems by their node id in a comment: % [node_id]
5. Mark unclear steps with % TODO.

Section to draft:
`,
  },

  check_notation: {
    label: 'Check notation consistency',
    purpose: 'Find undefined or inconsistent mathematical notation.',
    instructions: `Compare the LaTeX content below against the configured notation file provided in context.

Report:
1. Any notation used in the LaTeX that is not defined in the configured notation file
2. Any notation used inconsistently (same symbol for different things, or different symbols for the same thing)
3. Suggested additions to the configured notation file

LaTeX content to check:
`,
  },

  find_relevant: {
    label: 'Find relevant assets for a query',
    purpose: 'Locate research nodes relevant to a mathematical question.',
    instructions: `From the research nodes provided in context, identify which ones are most relevant to the following topic or question. Explain briefly why each is relevant.

Query:
`,
  },

  summarize: {
    label: 'Summarize selected nodes',
    purpose: 'Summarize selected nodes and their mathematical relationships.',
    instructions: `Provide a concise mathematical summary of the research nodes provided in context. Explain how they relate to each other and what they collectively establish.
`,
  },
};

/** Compatibility view for the existing Copilot chat UI. */
export const PROMPT_TEMPLATES: Record<string, { label: string; template: string }> =
  Object.fromEntries(
    Object.entries(RESEARCH_WORKFLOWS).map(([id, workflow]) => [
      id,
      { label: workflow.label, template: workflow.instructions },
    ])
  );
