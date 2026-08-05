# Upstream Core Integration

## Preserve the package

Keep `src/virtual_lab` importable and preserve upstream files/license. Add compatibility tests before invasive changes.

Recommended production integration:

```text
src/virtual_lab/                         upstream package
backend/app/services/meeting_engine/
  legacy_adapter.py
  async_engine.py
  prompt_compiler.py
  state_machine.py
  budgets.py
  summary_validator.py
```

## Original team semantics

For M specialist members and R discussion rounds:

- each discussion round: lead, then every specialist in order
- final: lead alone synthesizes
- base calls: `R * (M + 1) + 1`

Example lead + A + B, R=2:

```text
Lead, A, B, Lead, A, B, Lead(final)
```

Seven calls.

## Original individual semantics

For R rounds:

- expert
- critic
- repeat
- expert final

Base calls: `2 * R + 1`.

R=2:

```text
Expert, Critic, Expert, Critic, Expert(final)
```

Five calls.

## Zero-round trap

Upstream zero rounds means:

- team: lead only, no specialists, no separate synthesis
- individual: expert only, no critic

Preserve only as Advanced “one-shot compatibility mode.” Normal UI defaults to two rounds.

## Shared transcript

Each turn receives the current agent's system prompt plus the shared transcript. Model roles are role-conditioned calls, not independent persistent agents. Explain this accurately in Methodology.

## Required changes

- provider/client injection
- explicit critic
- async events
- iterative tool loop
- per-call usage/cost
- structured output
- evidence IDs
- budgets/timeouts/retries
- persistent database records
- safe cancellation/pause/intervention
- versioned prompts

## Prompt versioning

At launch preserve:

- prompt template ID/version
- rendered system prompt per agent and SHA-256
- meeting-start prompt/hash
- turn instruction/hash
- summary schema/version
- human interventions

Never expose hidden reasoning.

## Usage

Store per provider call:

- run/turn/agent version
- provider/model
- provider request ID
- input/output/cached/reasoning usage if reported
- estimated usage with explicit `is_estimate`
- pricing version and cost or null
- latency/retry/final status

Mixed models are expected.

## Tool behavior

Translate PMC into the registry and improve:

- NCBI tool/email identification
- explicit search/article/source caps
- timeouts and bounded retry
- metadata retention
- stable source creation
- full-text/truncation state
- iterative calls up to max_tool_calls
- cancellation/budget check after tool result

V1 tools are read-only.

## Compatibility tests

1. Team two members/two rounds -> seven calls and exact order.
2. Individual two rounds -> five calls and exact order.
3. Zero-round team -> lead only.
4. Zero-round individual -> expert only.
5. Specialist sees prior transcript.
6. Agent receives correct system prompt.
7. Final team call receives final synthesis instruction.
8. Tool request/result becomes transcript and event record.
9. Configured critic model is used.
10. Mixed model calls have distinct usage records.
11. Existing `Agent` prompt property remains compatible.
12. Legacy Markdown/JSON export remains available.

## Attribution

About/Methodology and README must credit the upstream repository and Nature paper, distinguish new application code, and retain the MIT license.
