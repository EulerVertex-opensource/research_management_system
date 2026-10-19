# Math Engineering: A Framework for Collaborative Human–AI Mathematical Research

> Working notes for a future paper. The primary contribution is math engineering, a methodology for organizing mathematical research; Research Assistant is its current software realization. This document records the argument, design principles, implementation evidence, and proposed evaluation. It does not report experimental results or establish priority over related work.

Implementation descriptions were reviewed against commit `3d0ae8c` on October 17, 2026. The ontology and methodological interpretation below synthesize the implementation; they do not imply that every proposed research benefit has been measured.

## 1. Central thesis

**We propose math engineering: organizing mathematical research through modular components, explicit interfaces, reusable libraries, a coherent project architecture, and repeatable processes for checking, integrating, and communicating changes.**

The **math engineering framework** organizes a research project into connected modules for definitions, mathematical claims, proof attempts, reusable results, and manuscript sections. Each module has a clear purpose and explicit relationships to the others. The framework records dependencies and review status, assembles relevant context for individual tasks, and identifies work affected by changes. Math researchers and AI assistants use this shared structure to develop individual components, integrate reviewed contributions, and turn results into a coherent manuscript.

The framework is grounded in an **ontology of mathematical research**: a shared account of research objects, their relationships, and the meanings of their states. This ontology supplies the conceptual foundation; math engineering supplies the broader methodology for organizing work around it.

The motivating analogy is software engineering. Software engineering combines modular design and explicit interfaces with reusable libraries, version control, testing, review, and continuous integration and delivery. Mathematical research can draw on these practices to organize reusable knowledge, project-specific claims and proofs, exploratory attempts, and manuscript presentation, while establishing repeatable processes for checking, reviewing, and integrating contributions. These parts remain connected through explicit relationships, allowing collaborators to work on one part with a clear account of what it assumes, what it provides, and how changes will be assessed and shared.

An explicit, shared representation of research state is the infrastructure supporting this organization. It records the project objective, definitions, assumptions, dependencies, attempts, and review history. Its value extends beyond preserving notes: it enables work to be decomposed, assigned, reused, checked, and integrated.

A prominent strand of AI for mathematics focuses on generating proofs and formalizing arguments for machine verification, particularly in Lean. Google DeepMind's AlphaProof searches for proofs of mathematical statements in Lean ([AlphaProof announcement, 2024](https://deepmind.google/blog/ai-solves-imo-problems-at-silver-medal-level/)); Harmonic's Aristotle combines Lean proof search with informal reasoning that generates and formalizes lemmas ([Aristotle paper, 2025](https://arxiv.org/abs/2510.01346)); and Math, Inc.'s Gauss is presented as an autoformalization agent assisting expert mathematicians with formal verification ([Gauss introduction](https://www.math.inc/gauss)). These examples establish proof generation and formalization as important areas of activity, without implying that all AI-for-mathematics projects share the same scope or that these teams disregard human collaboration.

**Our focus is how to organize the full mathematical research process so that humans and AI can work together to produce reliable, readable research, and humans can collaborate more effectively with one another.** This includes choosing and refining questions, developing shared definitions, exploring ideas, preserving failed attempts, dividing work, reviewing evidence, integrating results, and writing explanations that other mathematicians can understand and assess. For human–AI collaboration, the framework supplies persistent context, explicit tasks, and reviewable contributions. For human–human collaboration, it supplies shared assumptions, modular responsibilities, research history, and traceable revisions. Proof generation and formal verification can contribute within this broader process; our methodological emphasis is on making their outputs, together with human contributions, understandable, reusable, and maintainable throughout a research project. Reliability and readability are objectives to evaluate through mathematical review and human comprehension, alongside any formal verification used.

## 2. Draft abstract

Mathematical research often interleaves evolving definitions, speculative claims, proof attempts, established results, and manuscript prose within the same working documents. This coupling makes it difficult to divide work, reuse results, recover context, and assess the consequences of a change. We propose math engineering, a methodology for mathematical research drawing on modularity, interfaces, libraries, layered architecture, and repeatable integration workflows. The methodology is grounded in an ontology of mathematical research that specifies research objects, their relationships, and their review states. It separates mathematical statements from proof attempts, reusable knowledge from project-specific work, and research development from manuscript presentation, while recording their dependencies explicitly. These boundaries provide a common basis for collaboration among researchers and AI assistants. We describe Research Assistant, a file-based realization that combines structured research objects, reusable knowledge, coordinated searches for constructions and counterexamples, task-specific context assembly, configurable review policies, and manuscript change analysis. Existing manuscripts can be brought into this structure through guided extraction and section adoption, while an overview exposes blockers and decisions requiring human attention. We also explain how validation, review, synchronization, and manuscript preparation provide elements of a workflow analogous to continuous integration and delivery. We propose evaluating whether this organization improves modular collaboration, reuse, comprehension, and revision efficiency, accounting for the cost of maintaining the structure.

## 3. Motivation: tightly coupled research is difficult to develop collaboratively

### 3.1 Human collaboration depends on context that is costly to reconstruct

In the workflow motivating this project, researchers develop ideas through individual work, conversations, seminars, correspondence, and evolving notes. A collaborator may understand the main conjecture without knowing which version is current, which hypotheses matter, or why a promising approach was abandoned.

Face-to-face discussion communicates intuition effectively. The difficulty is preserving enough of its outcome for someone who was absent, joins later, or returns after a long interruption. The workspace should let that person recover both the current argument and the reasons behind important decisions.

This is a motivating observation from our experience, not a universal description of mathematical practice. The eventual paper should support its broader claims with interviews, project histories, or relevant literature.

### 3.2 Question-by-question AI interaction fragments project context

A prompt such as “prove this lemma” may omit the larger objective, the intended application, a nonstandard definition, earlier failed attempts, or an assumption the team has already rejected. Supplying a long transcript does not automatically make those distinctions explicit.

The desired interaction is more continuous: the AI can identify the current task, recover its mathematical prerequisites, consult earlier attempts, and leave usable records for the next collaborator. A persistent project representation provides a basis for that continuity, although it cannot guarantee that a model understands every relevant idea.

### 3.3 Generating mathematics and making it digestible are different tasks

Even when an AI produces a useful argument, a researcher must determine what it claims, check its hypotheses, locate its dependencies, assess gaps, and understand the main idea. Long outputs can make that work expensive.

The motivation does not require claiming that AI routinely produces correct, original, publishable papers. The narrower point is enough: **candidate mathematical output has limited collaborative value until people can inspect and integrate it.** The examples in the central thesis illustrate specific proof-generation and formalization capabilities. Further claims about AI capabilities should use dated sources and distinguish proof generation, formal verification, and original research.

### 3.4 An early LaTeX draft serves too many purposes

A working draft may contain definitions, speculative statements, complete proofs, incomplete proofs, failed calculations, reminders, and prose intended for publication. Its presentation order need not match the logical dependency order or the history of discovery.

As a result, a collaborator may struggle to distinguish a desired theorem from an established one, or a discarded argument from the current proof. Turning research into a paper then requires both mathematical review and reconstruction of a coherent narrative.

The proposed methodology gives exploratory research its own structure, while keeping the manuscript as the carefully selected explanation for human or AI collaborator.

### 3.5 Missing boundaries make local changes expensive

A change to a project's assumptions—such as weakening a regularity condition, removing compactness, or changing the permitted parameter range—can affect several lemmas, proof attempts, and manuscript sections. If these dependencies exist only in prose or a researcher's memory, collaborators must rediscover which arguments remain valid and which require revision. The same issue arises when assumptions are expressed through a project-specific definition whose meaning changes. Similarly, using a result from another paper requires extracting its exact assumptions and checking that it applies in the current setting.

The engineering question is how to make these boundaries and connections explicit. A collaborator should be able to work on a lemma against a stated contract, use a known theorem through a documented interface, and identify which parts of the project need attention when that interface changes.

## 4. What math engineering means

### 4.1 Separation of concerns and controlled dependencies

The approach organizes mathematical work into components with distinct responsibilities and explicit connections. The aim is to reduce unnecessary coupling while preserving genuine mathematical dependencies. Even well-separated components interact: software layers communicate through interfaces, and mathematical results depend on hypotheses, definitions, and other results.

A useful conceptual architecture has four parts:

| Part | Responsibility | Connection to the other parts |
|---|---|---|
| Knowledge foundation | Maintain definitions, notation, sources, and a curated library of known results | Supplies explicitly stated concepts and results to project work |
| Research development | Formulate project claims, explore ideas, develop proofs, and retain failed attempts | Uses the foundation and produces candidate mathematical contributions |
| Workflow and integration | Coordinate tasks, validate structure, record review, and incorporate changes | Tracks whether components are ready to be used together and what needs renewed attention |
| Presentation | Select results and explain them in manuscript sections | Uses accepted research objects through recorded source relationships |

These are conceptual responsibilities, not a requirement for separate programs or a literal one-to-one mapping to frontend, backend, and database. The important design property is that each part can evolve through understood boundaries. For example, reorganizing the exposition should not require reorganizing the proof-dependency graph.

### 4.2 Mathematical statements as interfaces, proofs as implementations

A result's interface consists of its definitions, hypotheses, and conclusion. A proof supplies a justification for that interface. Several proof attempts may target the same statement, and a downstream argument may use the result without reproducing its proof.

This distinction supports modular work. One collaborator can develop a supporting lemma while another explores the main theorem conditional on that lemma. The unresolved dependency must remain explicit, and the combined result cannot be treated as accepted until the necessary work is reviewed.

If a lemma's proof changes while its statement remains fixed, downstream arguments may continue to use the same interface, subject to review of the replacement proof. If its hypotheses or conclusion change, downstream uses need to be reconsidered. A record of dependency and version information makes that difference visible.

The framework provides boundaries that humans and AI can work within: a specified target, relevant definitions, declared dependencies, an attempt record, and a reviewable output. This is the organizational basis for dividing research work.

### 4.3 Libraries and reuse

Reusable mathematical knowledge should have an explicit place in the architecture. A known result can be represented by its statement, assumptions, definitions, source, and review status, then referenced by multiple project results.

The current framework provides library collections for known assets and definitions. Accepted library results can be used as known inputs without sending them through a new proof attempt each time; edits return them to draft. This makes reuse a supported workflow and helps distinguish background knowledge from the project's intended contribution.

Using a library result still requires checking that its hypotheses hold in the new application. Broader distribution, dependency resolution across projects, and package-style version management are possible extensions beyond the current local library mechanism.

### 4.4 Mapping engineering practices to mathematical research

The analogy has limits. A theorem's hypotheses and conclusion can serve as an interface, but checking examples is not a substitute for a proof. A dependency graph records declared logical relationships; it does not verify that those relationships justify an argument. Mathematical creativity, taste, and explanatory judgment remain central.

| Practice | Mathematical interpretation | Purpose |
|---|---|---|
| Specification | State the problem, scope, assumptions, intended contribution, and required results | Make the research objective explicit |
| Architecture and separation of concerns | Separate knowledge, research development, integration, and presentation | Let different responsibilities evolve through explicit connections |
| Modularity and interfaces | Give results stable identities and explicit hypotheses and conclusions; keep proof attempts separate | Allow work on a component against a stated mathematical contract |
| Libraries | Curate reusable definitions and known results with sources and assumptions | Reuse established inputs across research tasks |
| Dependency tracking | Record which results and definitions a claim uses | Expose prerequisites and consequences of changes |
| Testing | Search for counterexamples and record the limits of the search | Challenge statements before investing in proofs |
| Review | Record acceptance of a particular version and the basis for that acceptance | Separate proposed work from reviewed work |
| Version control | Preserve revisions, failed approaches, and research decisions | Support collaboration and recovery of context |
| Continuous integration | Repeat structural checks and review checks when contributions are incorporated | Detect missing dependencies, stale acceptance, and incompatible changes |
| Delivery and presentation | Prepare, review, compile, and share a manuscript linked to accepted results | Turn the research state into a coherent reader-facing artifact |

The methodology should be lightweight enough to accommodate unfinished thinking. An intuition can remain a short freeform idea. Structure becomes more demanding when an idea becomes a precise claim, an actionable proof attempt, or a result used elsewhere.

## 5. An Ontology of Mathematical Research

> **Author note for the paper:** Include diagrams to explain this section. An ontology diagram could show the main research objects and their labeled relationships; a companion workflow diagram could distinguish a claim, its proof attempts or search candidates, verification, and acceptance. Use a small running example to make these relationships concrete, and distinguish logical dependencies from workflow and presentation links visually.

### 5.1 Scope and purpose

Here, an ontology specifies the concepts used to describe mathematical research, the relationships among them, and constraints on their interpretation. This follows the knowledge-representation use of the term: an ontology makes the meaning of a domain vocabulary explicit, independently of its particular storage format. [Gruber's account of ontology](https://tomgruber.org/writing/definition-of-ontology.pdf)

The scope is the organization of research activity and its artifacts: claims, attempts, evidence, decisions, and exposition. The framework can record a definition of a group or a manifold, but its ontology concerns that definition's role in a research project, its dependencies, and its review history. We do not propose a comprehensive formal ontology of all mathematical objects.

This shared vocabulary gives math researchers and AI assistants a consistent way to describe contributions. An agent reporting a failed attempt should leave an attempt record and an obstruction; it should not thereby mark the target claim as false. The ontology makes this distinction explicit, and the workflow determines what happens next.

### 5.2 Research objects and their meanings

The framework distinguishes objects that have different meanings and lifecycles:

| Object | What it records |
|---|---|
| Project contract | Main problem, scope, intended contribution, and required results |
| Definition | A standard or project-specific concept, defined condition, or named hypothesis and its notation, with dependencies on other definitions |
| Mathematical asset | A theorem, lemma, proposition, example, construction, or remark; its source and dependencies |
| Construction specification | The required properties of an object to be found, recorded in a construction asset's statement |
| Idea | An intuition, open question, observation, possible approach, test case, or risk |
| Proof plan | One attempt at proving one target claim, including its outcome |
| Search candidate | A proposed object with a pass, fail, or unknown verdict for each property checked, plus the supporting reasoning |
| Search round record | Directions explored, candidate references, obstructions, and limitations of a round of search |
| Falsification check | A search for counterexamples, including its coverage and limitations |
| Counterexample | An example proposed or confirmed to refute a particular claim |
| Decision and handoff | Researcher direction, unresolved work, and where a collaborator stopped |
| Approval record | Acceptance tied to a particular content version, with provenance |
| Writing brief | A manuscript section's purpose, selected results, gaps, and exclusions |
| Manuscript section | Reader-facing exposition that presents selected research objects |

These distinctions prevent several conceptual mistakes: a failed plan does not make a conjecture false; an unsuccessful counterexample search does not prove it true; a recorded proof is not automatically a reviewed proof; and a valid supporting result need not appear in the final paper.

A mathematical statement and its proof are conceptually distinct even when stored in one asset file. Likewise, a library entry identifies a reusable result's role and provenance; it need not introduce a new mathematical kind. The conceptual model should be explained independently of how many files or tables implement it.

Definitions are identified by their use and meaning, including concepts introduced within a project. The extraction workflow calls for separate nodes for named hypotheses and for distinct meanings of the same term. A standing assumption such as “throughout, the domain is bounded” has a different role from a definition specifying what “admissible domain” means. This distinction lets dependencies track changes to the concepts and conditions that results actually use. Extraction is guided by agent instructions and researcher review; it is not a guarantee that every implicit dependency will be recovered.

### 5.3 Relationships and their meanings

The following are conceptual relationships. Some are represented by metadata fields, some by review records or manuscript bindings, and reverse relationships can be derived.

| Relationship | Meaning | Important distinction |
|---|---|---|
| A result depends on another result | The supporting result is a declared prerequisite of the argument | A declaration records intended use; it does not verify the argument |
| A result uses a definition | Its statement or argument relies on the concept as defined | A definition change can affect the interpretation of the result |
| A proof attempt targets a claim | The attempt seeks to establish that particular statement | Several attempts may target the same claim and have different outcomes |
| A search candidate targets a specification or claim | The object is tested against required construction properties, or against hypotheses and the negation of a conclusion | Surviving the proposing worker's checks still requires a separate verification and acceptance step |
| A round summarizes candidate searches | The record connects explored directions to failures, obstructions, and remaining limitations | A recorded obstruction is evidence about an approach, not automatically a proof of nonexistence |
| A plan is inspired by an idea | The idea records an origin of the approach | Inspiration is distinct from a logical prerequisite |
| An example refutes a claim | The example is proposed as a witness against the claim | Its verification and review state determine whether refutation is accepted |
| A result cites a source | The source and location identify the origin of mathematical content | A citation still requires checking that the source supports the stated use |
| An approval concerns a content version | Acceptance applies to specified recorded content | It does not automatically cover later revisions |
| A manuscript section presents a research object | The section uses specified mathematical content in its exposition | Presentation order and proof-dependency order serve different purposes |

### 5.4 States, constraints, and valid interpretations

The ontology should specify what recorded states mean and which conclusions they support. The workflow supplies the procedures for changing those states.

- **Claim and attempt are separate:** an attempt's failure records an obstruction to that approach, not a refutation of its target. A successful attempt records a candidate proof whose acceptance is a separate decision.
- **Search and proof provide different evidence:** a search that finds no counterexample establishes only its recorded outcome within the stated coverage.
- **Specification acceptance and existence differ:** approving the properties of a desired construction establishes the search target. It does not establish that an object satisfying them exists.
- **Candidate survival and acceptance differ:** `survived` means every recorded property check passed in the proposing worker's assessment. Verification can still reject that candidate; exhausting a search budget does not prove nonexistence.
- **Review is version-specific:** acceptance refers to particular content and provenance. Explicit human review and acceptance under an automatic policy must remain distinguishable.
- **Approval and re-check obligations can coexist:** under the configurable flagging policy, a downstream result may retain its approval while carrying an outstanding dependency re-check. Its status alone therefore does not summarize all review obligations.
- **Relations have defined roles:** a proof plan targets one claim; result dependencies and uses of definitions identify different kinds of prerequisites. Missing references and cycles in proof dependencies are structural problems.
- **Knowledge state and mathematical truth differ:** draft, approved, failed, and deprecated describe the recorded research state. None is a standalone certificate of mathematical truth.

These constraints explain why the ontology is more than a collection of labels. They constrain how humans and AI interpret records, while validation and review enforce only the parts that the implementation can check.

### 5.5 Relationship to the implementation and methodology

Research Assistant realizes parts of this conceptual model through typed Markdown records, relationship fields, validation rules, review records, and manuscript bindings. This paper should make their meanings explicit as a lightweight domain ontology. A separate OWL encoding or general-purpose ontology reasoner is not part of the current implementation.

The ontology defines the common language of the framework. Math engineering uses that language to establish module boundaries, organize libraries, assemble task context, coordinate review, and integrate contributions. The paper's broader contribution is the methodology and its realization; the ontology is a supporting conceptual contribution whose usefulness should be evaluated within that workflow.

## 6. Research Assistant: Implementation as a VS Code Extension

Research Assistant implements the math engineering methodology and research ontology as a VS Code extension. This section explains how its file-based workspace, agent workflows, review controls, and dashboard turn the preceding ideas into tools for everyday mathematical research.

> **Author note for the paper:** Include diagrams to explain the implementation. An architecture diagram could connect the VS Code dashboard, shared research files, agent context and workflows, review controls, and manuscript tools. A workflow diagram could follow one contribution from a researcher or AI assistant through checking, review, and integration into the manuscript. Annotated screenshots could show how researchers inspect dependencies, review results, and identify blockers. Keep these figures focused on how the extension realizes the methodology, complementing the conceptual diagrams in Section 5.

### 6.1 Separate kinds of research knowledge

The ontology distinguishes claims, attempts, evidence, decisions, and presentation. The framework implements these distinctions through separate records and lifecycles, so changes to an exploratory plan, a reviewed result, and manuscript prose can be handled according to their different meanings.

### 6.2 Make module interfaces and dependencies explicit

Assets declare dependencies on other assets and uses of definitions. Plans identify their target claim and may link to ideas that inspired them. Counterexamples identify the claims they refute. Manuscript sections identify the objects they present.

A claim and the attempts to prove it are distinct objects. This separation realizes the statement–implementation distinction: the target retains its identity while different approaches can be attempted, compared, and reviewed. A library result can provide the same kind of declared input as a result developed within the project, with its origin retained.

The framework derives reverse relationships and dependency order from these declarations. It checks missing references and dependency cycles, and exposes progress, coverage, and change impact in the dashboard.

The proof-dependency portion should be acyclic; the broader research representation also includes historical, exploratory, and presentation relationships. It would be misleading to describe every relationship as a proof dependency.

This structure helps a collaborator answer: “What does this theorem need?”, “What relies on this definition?”, and “Which manuscript sections may need attention after this change?” Its usefulness depends on the accuracy and completeness of the recorded relationships.

### 6.3 Preserve attempts and uncertainty

Ideas may remain open, become resolved through a plan or result, or be archived. Proof plans remain available after success, failure, or abandonment. A failed plan records its obstruction, and later plans must explain how they differ from earlier failures.

The underlying principle is that the path through research has continuing value. Preserving it may prevent repeated mistakes and make future exploration more informed. Those effects should be evaluated rather than assumed.

### 6.4 Give AI a durable project map and focused task context

The workspace retains the broader research state, while the context assembler selects material appropriate to the current stage. For example, proof execution receives the target statement, current plan, direct dependency statements, and relevant definitions. Planning can additionally receive previous failures and related ideas.

Object search focuses on the target statement or construction specification. Search workers receive assigned directions and a compact board of prior obstructions, near-misses, and explored directions. A researcher-requested follow-up search can also include failures from earlier proof attempts. Counterexample verification receives the proposed example and relevant mathematical context; construction verification receives the proposed object and specification while excluding the candidate's own checks. These context boundaries support a fresh assessment, but do not establish statistically independent judgment or prevent correlated reasoning errors.

Context manifests record included material, exclusions, and budget-related omissions. The intended benefit is an AI collaborator that can recover relevant context without repeatedly reading the entire project. Context selection can still omit something important; this tradeoff belongs in the evaluation.

### 6.5 Make review version-aware

The default workflow asks a researcher to review the project, definitions, citations, construction specifications, and proposed results. Approval records bind acceptance to content digests. A construction specification has its own statement-based approval, distinct from acceptance of a subsequently found object and its proof. During proof execution, the target statement is frozen so an attempted proof cannot silently succeed by changing the claim.

Review timing and responses to uncertainty are configurable. The default **Careful** policy requires agreement on definitions used by main results before proof work, searches for counterexamples before proving eligible results, returns downstream results to review when their dependencies change, and waits on unanswered questions. The **Fast** preset defers some checks, limits pre-proof counterexample search to main results, and marks affected downstream results for re-check while preserving their approvals. Individual policies also govern missing definitions and whether a blocked task is parked or given an additional attempt. These are workflow settings, not measured levels of mathematical correctness.

The implementation also supports researcher-configured automatic approval for selected categories, disabled by default. Consequently, the paper must distinguish **explicit human review**, **acceptance under an automatic policy**, and **mathematical correctness**. A status label alone does not establish the last of these.

Review policies, automatic-approval permissions, and search effort limits are separate controls. An evaluation must report all three; otherwise, faster progress could simply reflect fewer checks or less human involvement.

Digests detect changes in normalized recorded content. They do not establish semantic equivalence between statements or certify the validity of a proof.

### 6.6 Share research memory across collaborators and sessions

The implementation stores authored research context in ordinary Markdown files with structured metadata, alongside LaTeX and bibliography files in a Git project. Decisions, checks, search candidates, round summaries, handoffs, and approval records can travel with the project. Search progress is reconstructed from records matching the current target statement, so evidence for an older statement is not silently treated as current. Local session mechanics remain separate.

This makes research context inspectable through familiar tools and supports resuming work in another collaborator's clone. Small files can make independent edits easier to merge, but substantive conflicts still require mathematical judgment.

The broader methodological requirement is portable, persistent research memory. Markdown, Git, VS Code, and Overleaf are choices made by this implementation.

The extension also checks that research artifacts occupy recognized locations. Agent hooks reject recognized writes that would create unsupported folders or untyped folder notes, and layout validation reports misplaced content. This makes the shared structure an operational contract: material outside the indexed layout cannot be assumed to appear in the dashboard or agent context. These checks support consistency; they are not a general security boundary for arbitrary agent actions.

### 6.7 Treat manuscript writing as a connected intellectual task

The manuscript has its own outline and section briefs. Each brief specifies what the reader should learn and which research objects support that purpose. Results can be deliberately excluded, and research dependency order can differ from exposition order.

The implementation links manuscript sections, and annotated blocks within them, to relevant source components such as statements, proofs, and citations. Change analysis can distinguish a proof revision from a statement revision: a section presenting the proof may need updating even when a section merely stating the theorem does not.

This supports focused revision and traceability. It does not make manuscript writing a mechanical concatenation of nodes. Motivation, notation, transitions, examples, and explanation of the main insight require deliberate authorial decisions. Accepted TeX remains editable, and changes in its mathematical content must be reconciled with the research objects.

### 6.8 Organize searches for objects as well as proofs

The framework now provides a common search protocol for **refutation** and **construction**. Refutation seeks an object satisfying a claim's hypotheses and violating its conclusion. Construction seeks an object satisfying an approved list of required properties. A construction asset describing an already-given object can still follow the ordinary proof workflow; the search branch applies to specifications of objects yet to be found.

Search proceeds in bounded rounds. The loop assigns worker slots different directions, such as small cases, known examples, algebraic constructions, or repair of a promising failed candidate. The bundled workflow directs agents to perform these searches in separate workers, potentially in parallel. Each worker records candidate objects and property-level reasoning. A summary stage extracts obstructions and limitations, and subsequent workers receive a compact shared board rather than the entire search history.

A surviving candidate goes through a separate verification stage. A confirmed counterexample proceeds to acceptance of the refutation. A verified construction is written into its asset with the construction and proof, then submitted for acceptance. Failed and rejected candidates remain available as research memory. Search limits determine when the workflow asks for direction or sets a task aside; they do not establish that the search space has been exhausted mathematically.

The implemented verifier is written reasoning (`verifier: reasoning`). Code-based and formal proof checkers remain possible extensions. The methodological contribution is the explicit separation of specification, proposal, property checks, verification, and acceptance, with records that humans can inspect throughout.

### 6.9 Bring existing research into the framework

Researchers can begin with an existing manuscript, notes, or source papers. The extraction workflow guides an agent to identify results, proofs, definitions, and dependencies, retain their provenance, and propose project goals for researcher review. This provides a path from an existing working document into modular research objects.

For supported LaTeX layouts, a previewable manuscript-adoption command splits inline sections into files while preserving the moved text, or adds management markers around existing section inputs. It creates an ordered outline and initially empty section briefs. Mapping those briefs to extracted results and annotating manuscript passages remain subsequent agent-assisted steps, followed by review.

This supports a second entry point into the methodology: organizing work already in progress. It also makes adoption cost an empirical question. The parser handles particular document structures; preservation of text does not establish semantic equivalence for every LaTeX project, and compilation and review remain necessary. Moving text can also affect existing editor annotations.

### 6.10 Make coordination visible to researchers

The revised overview presents who needs to act next, which results block the main goals, and which decisions can wait. Approval requests remain in a review queue, with actions to read the content, accept it, or request changes. Graph views can emphasize a selected goal or its blockers, while a timeline describes recent loop events in ordinary language.

This interface makes the dependency structure useful for human coordination: it helps a researcher decide where attention is needed and what an AI worker is waiting for. Activity-based warnings can suggest that a session has gone quiet, but they are operational heuristics rather than measurements of mathematical progress. The timeline reflects local loop events; shared research records and Git history provide the durable basis for collaboration across clones.

## 7. Research development, integration, and delivery

### 7.1 The development loop

The current loop follows a staged process, with branches for proof development, construction search, counterexamples, failed attempts, and researcher direction:

1. **Agree on the objective.** Record and review the problem, scope, intended contribution, and required results.
2. **Decompose the work.** Create precise claims and definitions, identify dependencies, and locate relevant literature or reusable library results. Under the default policy, agree on definitions used by main results before proof work.
3. **Search against the target.** For proof tasks, search for counterexamples when the policy requires it. For a construction specification, obtain approval of its properties and search for a satisfying object. Record candidates, checks, obstructions, and limitations, and verify surviving candidates separately.
4. **Plan a proof when needed.** If a claim remains a proof target, record an approach informed by previous failures. A verified construction instead supplies an object and an argument that it meets the specification.
5. **Execute the plan.** Work against the fixed statement. Record the proof or document the obstruction; construction verification records the object and its property-wise justification through its own branch.
6. **Review and revise.** Accept the relevant version, request changes, revise the research direction, or park blocked work. A confirmed refutation leads to deprecation of the old claim and a new identity for a corrected statement.
7. **Prepare the exposition.** Once required results and dependencies are accepted, select the material, plan the manuscript, draft sections, and revise the prose.
8. **Maintain the project.** Share handoffs, incorporate collaborators' work, and revisit affected results and manuscript sections when inputs change.

The loop's `ready` state means that required results and dependencies satisfy the implemented approval-status conditions. Under the flagging policy, it can coexist with outstanding dependency re-check flags; it should not be described as a guarantee that all review obligations are resolved. It also does not mean that a manuscript is finished or that publication quality has been established. Exploration and communication may continue as the project develops.

### 7.2 A CI/CD analogy for mathematical research

The methodological counterpart of continuous integration is to make compatibility checks a repeatable part of incorporating research changes. A contribution should arrive with an explicit target, dependencies, evidence, and review state. After integration, the project should expose unresolved references, outdated approvals, and affected downstream work.

The counterpart of delivery is to prepare a coherent version of the research for its consumers: collaborators using the results and readers of the manuscript. This involves selecting accepted results, updating affected exposition, checking references, compiling the document, and reviewing the version to be shared.

The implementation already provides parts of this process: schema and dependency validation, content-based approval checks, manuscript impact analysis, synchronization checks, and an optional LaTeX build during preparation for sharing. Its staged loop coordinates research development, while synchronization and manuscript tools support integration and presentation. These mechanisms are a basis for the analogy; the project does not currently provide a complete hosted CI/CD service or autonomous publication pipeline.

A possible integration sequence to describe in the paper is:

```text
Research change
  -> structural and dependency checks
  -> review of affected mathematical content
  -> integration into the shared research state
  -> identification and revision of affected manuscript passages
  -> compilation and review of a shareable version
```

This process repeats as the project evolves. Structural checks can be automated; mathematical acceptance depends on the review or verification method used. The distinction should remain visible throughout the workflow.

## 8. Applications: Mathematical Papers Developed Using the Framework

> **Author note for the paper:** We plan to write several mathematical papers using Research Assistant and use these projects as application case studies. Fill this section with their mathematical goals, how the framework supported human–AI and human–human collaboration, and how the work progressed from exploration and review to readable manuscripts. Include concrete examples from the project histories, the resulting papers, and lessons about the framework's benefits and limitations once that evidence is available.

## 9. Contributions to claim, and evidence to provide

The paper can be organized around five proposed contributions:

1. **Math engineering as a research methodology.** Define a modular architecture with explicit mathematical interfaces, reusable libraries, and separate responsibilities for exploration, acceptance, and presentation.
2. **An ontology of mathematical research as the conceptual foundation.** Specify research objects, relationships, states, and constraints independently of their storage format, including distinctions between claims, attempts, construction specifications, candidates, evidence, and acceptance.
3. **A shared protocol for human–human and human–AI collaboration.** Show how component boundaries, focused context, structured searches, persistent attempts, configurable review policies, and visible coordination support division of work and integration of contributions.
4. **A repeatable path from research changes to manuscript revisions.** Explain how validation, dependency tracking, review, and source bindings support integration and delivery of a coherent research artifact.
5. **A working software realization.** Demonstrate the methodology in Research Assistant, with a real project walkthrough and reproducible artifacts where possible.

The claim of novelty should be about the specific methodological synthesis and demonstrated workflow. Modularity, mathematical libraries, dependency graphs, and version control each have substantial precedents; priority requires a related-work review.

### Implementation anchors for the authors

These links support checking descriptions against the repository. They are authoring references, not a substitute for scholarly citations or an evaluation.

| Topic | Relevant implementation |
|---|---|
| Shared workspace and collaboration | [README](README.md), [research synchronization](src/services/ResearchSync.ts), [research records](src/services/ResearchRecords.ts) |
| Research objects and relations | [node kinds](src/domain/nodeKinds.ts), [schema](src/domain/schema.ts), [graph](src/domain/graph.ts) |
| Construction and counterexample search | [search model and board](src/domain/search.ts), [search tests](tests/object-search.test.cjs) |
| Reusable knowledge | [library workflow](README.md), [library tests](tests/library.test.cjs) |
| Staged research workflow | [loop core](src/services/ResearchLoopCore.ts), [loop model](src/services/ResearchLoopModel.ts) |
| Context assembly and budgets | [research context](src/services/ResearchContext.ts), [context tests](tests/research-context.test.cjs) |
| Review, revisions, and automatic policy | [approval storage](src/services/ApprovalStore.ts), [digests](src/domain/digests.ts), [policy defaults](src/domain/loopSettings.ts), [automatic-mode tests](tests/auto-mode.test.cjs) |
| Review timing and dependency re-check policies | [policy types](src/models/settings.ts), [policy tests](tests/rigor.test.cjs) |
| Proof attempts and idea relationships | [proof ideas](src/services/ProofIdeas.ts), [proof-idea tests](tests/proof-ideas.test.cjs) |
| Manuscript planning and change impact | [manuscript writing](src/services/ManuscriptWriting.ts), [impact model](src/domain/manuscriptImpact.ts), [impact tests](tests/manuscript-impact.test.cjs) |
| Adoption of existing work | [extraction instructions](skills/extract-research-nodes/SKILL.md), [adoption command](src/cli/manuscriptWriting.ts), [manuscript tests](tests/manuscript-writing.test.cjs) |
| Recognized research layout | [layout rules](src/domain/layout.ts), [agent hooks](src/services/ResearchLoopHooks.ts), [layout tests](tests/layout.test.cjs) |
| Human-facing overview | [graph views](src/services/GraphViewModel.ts), [coverage matrix](webview-src/graph/CoverageMatrix.tsx), [impact view](webview-src/graph/ImpactView.tsx) |
| Coordination and activity history | [loop health](src/domain/loopHealth.ts), [event descriptions](src/domain/history.ts), [overview tests](tests/graph-view.test.cjs) |

## 10. Proposed evaluation

The central empirical question is whether organizing research into modules, interfaces, libraries, and repeatable integration workflows improves collaboration and comprehension enough to justify its maintenance cost.

Compare the framework with a realistic baseline using shared LaTeX, ordinary notes, Git where customary, and AI chat. Keep the mathematical tasks, model access, available source material, and time budgets comparable. Include both experienced users and newcomers, and report setup and maintenance effort. Record review policies, automatic-approval settings, worker counts, search budgets, and human review time so that reduced checking or increased compute is not mistaken for a methodological improvement.

| Research question | Possible task and measurements |
|---|---|
| Does the ontology support consistent interpretation? | Ask humans and AI to distinguish failed attempts from refuted claims, identify what was approved, and trace evidence to a claim; measure agreement, errors, and cases the vocabulary cannot express. |
| Can researchers work effectively across module boundaries? | Assign a supporting lemma and a downstream argument to different collaborators; measure clarification effort, hidden assumptions, and integration errors. |
| Does the library support reliable reuse? | Ask collaborators to select and apply a known result in another task; measure retrieval effort, duplicated work, and errors in checking hypotheses. |
| Does structured object search improve exploration? | Compare searches with and without the shared board at matched compute budgets; measure duplicated candidates, use of prior obstructions, coverage, and expert-confirmed validity. |
| Can an existing project be adopted accurately? | Organize a real LaTeX manuscript; measure missed or incorrect definitions and dependencies, migration effort, and changes in compiled output. |
| Does visible coordination help researchers intervene? | Ask collaborators to identify the next responsible actor and resolve a blocker; measure time, missed decisions, and understanding of re-check obligations. |
| Can a collaborator recover project context faster? | Ask a new collaborator to identify current claims, prerequisites, gaps, and abandoned approaches; measure time and accuracy. |
| Can AI resume work with less reconstruction? | Start a fresh session on an existing project; measure missing assumptions, repeated failed attempts, correction effort, and context usage. |
| Are candidate arguments easier for people to understand and review? | Ask experts to explain the proof idea and detect deliberately introduced gaps; measure accuracy, time, and confidence calibration. |
| Are changes handled more reliably? | Revise a hypothesis or definition; measure detection of affected results and manuscript passages, including false alarms and missed impacts. |
| Is manuscript development less costly? | Draft or revise a section from a fixed set of results; assess mathematical fidelity, readability, and human editing time. |
| What does maintaining the structure cost? | Track metadata edits, stale or missing links, migration effort, interruptions, and users' willingness to continue using the method. |

Useful ablations include removing explicit module interfaces, library access, failed-attempt history, the shared search board, dependency-aware context selection, or manuscript source bindings. Compare review policies separately, reporting both time saved and errors or unresolved obligations. Such comparisons can help identify which elements provide value beyond using a well-organized folder of notes.

Use blinded expert assessments where feasible, and distinguish small controlled tasks from longitudinal use in genuine research. Software tests provide evidence about implementation behavior; they do not establish improved mathematical productivity. Do not add performance numbers until measurements exist.

## 11. Related work to investigate

The literature review should address the following areas, with verified references added before publication:

- **Collaborative mathematical practice and computational notebooks:** how researchers preserve informal reasoning, discussion, and evolving arguments.
- **Formal proof assistants and mathematical libraries:** how explicit dependencies and checked proofs relate to a workflow whose primary artifacts remain informal mathematics.
- **Ontologies, mathematical knowledge management, and semantic documents:** precedents for conceptual vocabularies, research provenance, structured statements, and linked mathematical texts. Use [Gruber's definition](https://tomgruber.org/writing/definition-of-ontology.pdf) as an initial terminology reference, then compare the proposed concepts and constraints with relevant existing models.
- **AI theorem proving and mathematical research agents:** what these systems retain about project state, unsuccessful attempts, and human review.
- **Literate programming, version control, and reproducible research:** practices that connect explanation, structured artifacts, and revision history.
- **Software architecture, modular design, and CI/CD:** principles for separation of concerns, interface contracts, reusable components, and integration workflows, including the limits of transferring these ideas to mathematical research.
- **Human–AI collaboration and external memory:** evidence about task context, handoffs, trust, and human comprehension.

The positioning should emerge from this comparison. Formal verification could eventually strengthen individual results within the workspace; it is not implemented here as an end-to-end guarantee. Likewise, support for collaboration should be demonstrated through the workflow rather than inferred from the presence of a graph or a chat interface.

## 12. Limitations and open design questions

- **Maintenance burden:** fine-grained objects and links can become overhead. The right granularity may differ across mathematical areas and research stages.
- **Evolving architecture:** discovering the right definitions and decomposition is itself mathematical work. Module boundaries must be revisable; a premature architecture can obstruct exploration.
- **Ontological coverage:** the proposed categories may not capture every style of mathematical research. Evaluate ambiguous cases and allow the conceptual model to evolve without losing existing records.
- **Incomplete structure:** undeclared dependencies and unrecorded conversations remain invisible to automated checks. A clean graph can still describe an incomplete argument.
- **Review quality:** human acceptance can be mistaken, and automatic acceptance provides a different level of evidence. Both must remain distinguishable in reporting.
- **Limited checks:** counterexample searches have finite coverage; schema validation and successful LaTeX compilation do not establish mathematical truth.
- **Reasoning-based verification:** the current candidate verifier records written arguments. Separate worker contexts do not remove correlated errors, and a search limit supplies no proof of nonexistence.
- **Policy-dependent readiness:** flagging can preserve approvals despite outstanding dependency re-checks, and the current `ready` selection does not exclude those flags. They are held in local loop state, so the paper should not claim that every review obligation is durably shared across collaborators. Strengthening readiness and persistence is an implementation follow-up.
- **Adoption fidelity:** extracting implicit definitions and dependencies requires judgment, and automated section splitting supports a limited range of LaTeX structures. Migration requires review of both mathematical records and the resulting manuscript.
- **Context selection:** bounded context can remove a crucial detail or reinforce an inappropriate decomposition of the problem.
- **Exposition drift:** editable manuscript prose can diverge from research objects. Recorded source bindings help locate changes but cannot interpret every unannotated passage.
- **Tacit understanding:** taste, intuition, and the insight behind a proof are only partly captured by metadata and process records. Human comprehension needs direct evaluation.
- **Scope of evidence:** a working prototype and its tests support implementation claims. General claims about better mathematics or faster research require empirical evidence.

Potential extensions include links to formal proofs, richer mathematical change analysis, distribution and version management of libraries across projects, and hosted integration checks. They should be labeled as future work unless separately implemented and evaluated.

## 13. Suggested paper structure and author decisions

Suggested structure: introduction and motivating workflow; math engineering principles; an ontology of mathematical research; modular architecture, interfaces, and libraries; development and integration workflow; software realization; worked research case; evaluation; related work; limitations and discussion.

The strongest demonstration would follow one real project through a changed conjecture, at least one unsuccessful proof attempt, a collaborator handoff, review of a successful argument, and revision of the resulting manuscript. This would connect the methodological argument to observable research work.

Decisions for the team before turning these notes into a submission:

1. Which real mathematical project can supply a convincing case study and shareable history?
2. Which audience should determine the emphasis: working mathematicians, human–AI collaboration researchers, or research-tool builders?
3. Which benefit should be evaluated first: modular collaboration and reuse, recovering context, reviewing AI output, or producing and maintaining the manuscript?
4. How should the case study report explicit human review and any use of automatic approval?
5. What evidence can be shared, and which claims must remain proposals at submission time?

**Message to carry through the paper:** math engineering organizes mathematical research with the architectural discipline of an engineering project: explicit modules and interfaces, reusable knowledge, and repeatable development and integration workflows. An ontology of mathematical research provides the shared conceptual foundation, and Research Assistant makes the methodology concrete for collaboration among humans and AI.
