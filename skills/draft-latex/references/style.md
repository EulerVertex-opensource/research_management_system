# Manuscript style

Both `draft-latex` (while writing) and `revise-manuscript-prose` (while reviewing) use these rules. They cover prose only. Never change a mathematical statement, hypothesis, constant, or proof step to satisfy them.

## Transitions between blocks

Each block presents one node. The prose between two blocks should say why the reader needs the next result, or how it follows from the one before. One or two sentences is enough.

```tex
% research-assistant:endblock

The bound in Lemma~\ref{lem:energy} is uniform in $n$, which is what the compactness argument needs.

% research-assistant:block id=compactness sources=compactness_lemma@statement policy=assisted
```

Avoid empty connectors such as "Next, we prove the following lemma." They name the order without giving the reason.

## Expert audience

| Asset detail | In the paper |
|---|---|
| A routine verification written out line by line | "A direct computation gives ..." or "By Hölder's inequality, ..." |
| A restatement of standard definitions or known results | A citation, or one sentence |
| Exploratory remarks, earlier attempts, sanity checks | Omitted |
| Motivation repeated inside every asset | Said once, where the section opens |

Keep in full: every statement, every step that is not routine, and every place a hypothesis is used.

## Coded labels

Look for codes like `\([A-Z]{1,3}\d+\)` in the text, such as (M1), (S1), (F1) or (A2). Also look for bare node IDs such as `main_theorem` and asset-local names like "Claim 3" or "Step (S2)".

- Replace each one with a descriptive name. "By (M1)" becomes "By the monotonicity of $f$". "Step (S2) fails" becomes "The second reduction fails".
- If a hypothesis is cited often, the manuscript may define its own labels in a displayed list, such as (H1)–(H3) typeset with `\label`/`\ref` or `\tag`. After that, using (H1) is fine. Codes that only exist in the assets are not.

## Direct wording

The principle is to say what the mathematics does. The phrases below are examples of the figurative framing to rewrite. They are not a complete list, and none of them is banned mechanically.

| Instead of | Write |
|---|---|
| the decisive clause / the decisive step | name the clause or step and say what it gives |
| hinges on / turns on / rests on | "requires", "uses", "follows from" |
| the crux / the heart of the matter | state the difficulty directly |
| the key insight is that | state the fact |
| crucially / critically / notably | delete it, or say why the fact matters |
| it is worth emphasizing that | delete it |
| does the heavy lifting | "provides the main estimate" |
| the bridge between | "connects", or state the implication |

Repeating a precise term is better than swapping in a synonym. Write "compact" three times rather than "compact", "precompact" and "finite-dimensional" when only one of them is meant.
