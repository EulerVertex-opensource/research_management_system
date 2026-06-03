export const PROMPT_TEMPLATES: Record<string, { label: string; template: string }> = {
  extract_theorems: {
    label: 'Extract theorem nodes from paper notes',
    template: `From the notes or paper excerpt below, extract all theorem-like results (theorems, lemmas, propositions, definitions, examples).

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
    template: `Using the approved research nodes and ideas provided as context, suggest a detailed outline for a paper section.

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
    template: `Write a LaTeX section draft using the theorem/lemma nodes provided in context.

Rules:
1. Follow all macros defined in macro.tex — do not introduce new \\newcommand without checking.
2. Follow all notations defined in notations.tex — do not change notation.
3. Use \\begin{theorem}...\\end{theorem}, \\begin{proof}...\\end{proof} environments as defined in macro.tex.
4. Reference theorems by their node id in a comment: % [node_id]
5. Mark unclear steps with % TODO.

Section to draft:
`,
  },

  check_notation: {
    label: 'Check notation consistency',
    template: `Compare the LaTeX content below against the notations.tex file provided in context.

Report:
1. Any notation used in the LaTeX that is not defined in notations.tex
2. Any notation used inconsistently (same symbol for different things, or different symbols for the same thing)
3. Suggested additions to notations.tex

LaTeX content to check:
`,
  },

  find_relevant: {
    label: 'Find relevant assets for a query',
    template: `From the research nodes provided in context, identify which ones are most relevant to the following topic or question. Explain briefly why each is relevant.

Query:
`,
  },

  summarize: {
    label: 'Summarize selected nodes',
    template: `Provide a concise mathematical summary of the research nodes provided in context. Explain how they relate to each other and what they collectively establish.
`,
  },
};
