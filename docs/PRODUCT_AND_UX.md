# Product and UX Specification

## Product thesis

The upstream Virtual Lab demonstrates a useful structured multi-agent meeting pattern, but its reusable package is intentionally small and notebook-oriented. Virtual Lab Studio turns that pattern into a research operating environment that is understandable, repeatable, evidence-aware, collaborative, and auditable without requiring a researcher to write Python for every meeting.

## Primary goals

1. Make team and expert–critic meetings usable by non-programmers.
2. Make every run reproducible: exact agents, prompts, models, tools, evidence, parameters, usage, timestamps, and human interventions.
3. Make evidence and claim traceability first-class.
4. Support local/OpenAI-compatible and cloud providers through one interface.
5. Support iterative academic workflows and comparison, not only one-off chat.
6. Keep human judgment and review explicit.

## Non-goals for v1

- Autonomous wet-lab operation.
- Unsandboxed arbitrary code execution.
- Clinical diagnosis/treatment.
- Automatic changes to external systems.
- Automatic publication submission.
- A claim that model roles are independent human experts.
- Full Zotero/reference-manager replacement.
- Fine-tuning or model training inside the app.

## Personas

- Principal investigator: frames questions, assembles a council, makes decisions.
- Graduate researcher: uses guided templates and turns conclusions into follow-up work.
- Computational researcher: needs code/method critique and exact reproducibility data.
- Methods/statistics reviewer: needs blinded comparison, rubrics, and evidence traceability.
- Lab/workspace administrator: manages members, providers, budgets, retention, and audit.
- External reviewer: needs review-only access to completed runs and sources.

## Global navigation

```text
Workspace switcher
Dashboard
Projects
Agents
Templates
Evidence
Runs
Settings
----------------
Command palette
Methodology / Help
User menu
```

Inside a project:

```text
Overview | Meetings | Evidence | Notebook | Compare | Settings
```

## Routes

```text
/                                  landing
/methodology                       method, upstream attribution, limitations
/sign-in                           authentication
/app                               dashboard
/app/projects                      project list
/app/projects/new                  create project
/app/projects/:projectId           project overview
/app/projects/:projectId/meetings  meetings/runs
/app/projects/:projectId/evidence  evidence
/app/projects/:projectId/notebook  notebook
/app/projects/:projectId/compare   comparisons
/app/projects/:projectId/settings  project settings
/app/agents                        Agent Studio
/app/templates                     Template Library
/app/evidence                      cross-project evidence
/app/runs                          run history and queue
/app/meetings/new                  composer
/app/runs/:runId/live              Live Meeting Room
/app/runs/:runId                   Run Detail
/app/settings/profile              profile/preferences
/app/settings/workspace            members/defaults
/app/settings/providers            providers/models/pricing
/app/settings/governance           classification/retention/disclosures
/app/settings/audit                owner/admin audit
```

## Onboarding

1. Explain model-driven roles and human review.
2. Create workspace with name, organization optional, timezone, default classification.
3. Choose Demo Provider, OpenAI, or OpenAI-compatible provider.
4. Open the seeded demo project or create a real project.
5. Offer a replayable guided tour.

Do not require an API key before the user can explore the product.

## Project creation

1. Basics: name, abstract, domain, tags.
2. Research framing: question, hypotheses, objectives, desired decision/artifact.
3. Constraints/governance: available data, prohibited actions, ethics/safety, disclosure/conflicts, classification.
4. Suggested templates/agents, clearly labeled suggestions.

## Agent Studio

Structured fields first; raw instructions are advanced.

- title, short label
- expertise, goal, role
- advanced instructions
- limitations
- disagreement stance
- provider/model or inherit
- temperature override
- allowed read-only tools
- icon/accent
- compiled prompt preview
- immutable version history
- create, clone, archive

## Meeting modes

### Team

Lead and ordered specialists. Best for multidisciplinary synthesis.

### Individual expert–critic

Expert alternates with critic, then gives final revision.

### Ensemble + Merge

Several independent child meetings followed by a lower-temperature merge chair. Children do not see one another. Merge preserves distinct alternatives and unresolved disagreements.

## Six-step composer

### 1. Mode and template

Explain mode tradeoffs, expected use, and likely call count.

### 2. Agenda

- title
- agenda/objective
- required questions as reorderable rows
- rules/constraints as reorderable rows
- desired output
- human decision supported

An optional AI “Improve framing” action must show a diff and require acceptance.

### 3. Team

- lead/expert/critic/merge-chair slots
- searchable agent drawer
- drag reorder
- provider/model/tool badges
- redundancy warning, not hard block

### 4. Evidence and context

- available sources
- selected sources/excerpts
- prior summaries/human notes as separate categories
- page/section metadata
- token/context budget

### 5. Models and controls

- default and per-agent provider/model
- rounds and temperature
- tools and tool-call cap
- pause after round
- call/token/source/time/cost budgets
- retry summary
- structured-output strictness

### 6. Review

- speaking order
- base and maximum calls
- providers/model reachability
- evidence IDs/hashes
- policy warnings
- budget
- disclosure
- launch confirmation

Autosave with revision conflict protection.

## Live Meeting Room

Desktop signature visualization:

- center agenda/synthesis node
- agent nodes around it by speaking order
- active connection/pulse
- transcript is still primary

Mobile:

- compact agent strip and vertical turn timeline

Always show:

- stage, round, active speaker, elapsed time
- call/token/tool/cost budget
- transcript cards
- provider/model and role
- source/tool chips
- source drawer
- pause-pending/paused/cancel states
- human intervention form at safe checkpoint
- failure details with request/correlation ID
- reconnect state and event replay

Simulation is visibly labeled at all times.

## Run Detail

Tabs:

- Summary
- Transcript
- Evidence and citations
- Assumptions/disagreements/decisions
- Usage and cost
- Reproducibility manifest
- Human reviews
- Exports

Final summary separates:

- source-backed statement
- model inference
- hypothesis/proposal
- human decision

## Compare

- select 2–4 runs
- blinded A/B/C/D mode
- compare teams, prompts, models, sources, parameters, usage, outputs
- apply human rubric
- select preferred run with rationale
- convert unresolved difference into follow-up meeting

## Notebook

- human note
- AI draft requiring acceptance
- decision
- task
- unresolved question
- links to run/turn/evidence
- edit history
- convert to new meeting draft

## Empty states

Each has one clear action:

- no projects -> Create project
- no evidence -> Upload or search PMC
- no runs -> Start from template
- no provider -> Use Demo Provider or configure provider
- no comparisons -> Complete at least two runs

## Design system

Use `specs/design_tokens.css`.

### Experience

Premium scientific instrument: calm, precise, layered, and alive during a run. Glassmorphism communicates depth and grouping without compromising readability.

### Visual direction

- deep ink/navy canvas
- one low-contrast aurora mesh
- translucent navigation/metric surfaces
- more opaque reading/form/transcript surfaces
- cyan-blue active
- violet synthesis
- mint complete
- amber warning/budget
- rose error/destructive
- generous whitespace
- 8 px spacing grid
- 16–24 px radii
- strong type hierarchy
- restrained 180–240 ms motion
- intentional light theme

### Reusable components

- AppShell
- GlassPanel variants: nav, surface, reading, elevated, interactive
- PageHeader
- MetricCard
- AgentAvatar and AgentCard
- ModelBadge
- EvidenceChip and CitationLink
- RunStatusBadge
- BudgetMeter
- MeetingTimeline
- TurnCard
- ToolCallCard
- SourceDrawer
- StructuredSummary
- EmptyState and ErrorState
- CommandPalette
- ConfirmDialog
- FormSection
- StepWizard

### Accessibility

- WCAG 2.2 AA
- visible focus
- keyboard reordering
- screen-reader current-speaker/status announcements
- reduced-motion alternative
- orbit has equivalent text list
- icon/text in addition to color
- no raw HTML in Markdown
- reading text never below 14 px

### Responsive

- 1440+: full side nav, three-pane composer/evidence, orbit + transcript + drawer
- 1024: collapsed nav and two-pane layouts
- 768: top wizard progress, stacked agent builder
- 390: one-column, sticky primary action, linear live timeline, no horizontal page overflow

## Seed academic templates

1. Literature Review Council
2. Hypothesis Stress Test
3. Experimental Design Review
4. Statistical Analysis Plan
5. Code and Reproducibility Audit
6. Manuscript Peer Review
7. Grant Proposal Red Team
8. Research Ethics and Safety Review
9. Interdisciplinary Ideation Ensemble
10. Focused Expert–Critic Revision

## Human rubrics

General research plan, literature review, code/reproducibility, manuscript review. Scores 1–5 plus rationale and flagged passages. Optional model judging is future secondary evidence, never ground truth.

## Success measures

- time to first demo run
- run completion/failure rates
- human review rate
- valid citation rate
- template/agent reuse
- export-with-manifest rate
- usefulness/evidence quality ratings
- estimate vs actual usage/cost
- accessibility/performance results
