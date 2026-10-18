# Search directions

The loop assigns each worker slot one direction. It never assigns the same direction twice while untried ones remain. Directions also cover:
- a researcher's test case: an idea of kind `test_case` related to the asset, which the loop assigns before the catalog;
- a revisit of a direction already tried: when the loop says so, take a route the board does not show.

## Refute mode (counterexamples)

- `boundary_degenerate`: empty, zero, trivial, and equality cases of every hypothesis.
- `small_cases`: the smallest instances one by one (sizes, dimensions, values), worked out completely.
- `drop_hypothesis`: push one hypothesis to its edge, barely satisfied, to see whether the conclusion depends on it more than the statement admits.
- `known_counterexamples`: classical pathological objects, and counterexamples to related statements.
  - Search the library with `research-loop library search <words>`.
  - Use only papers in the index; never invent one.
- `extremal`: limits, very large or very unbalanced parameters, extremal configurations.

## Construct mode (constructions)

- `adapt_known`: start from a known construction with most of the properties (library, indexed papers) and change it.
- `symmetric_algebraic`: groups, quotients, explicit formulas or polynomials with parameters to tune.
- `products_limits`: build from simpler objects by products, sums, gluing, limits, or iterating a step.
- `small_case_search`: solve small parameters by hand, then look for the pattern.
- `repair_near_miss`: the pack includes the best near-miss in full. Change it so the property it failed holds while keeping the others.
- `nonexistence`: try to prove that no such object exists, starting from the board's obstructions.
  - Write no candidate.
  - Record what you establish with `record_idea` (kind `observation`, naming the asset), so the researcher sees it when the search is exhausted.
