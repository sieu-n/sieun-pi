# Rationale template

The prose that ships with the type sketch. Keep it to one page with sentence-case headings. Replace each note below with the real content.

## Problem

One paragraph on the goal and on what makes the shape non-obvious. Name the constraints from [Phase A](../SKILL.md#phase-a-ground-the-problem) the design must honor, such as types to interoperate with, callers that cannot break, and invariants that cross the boundary.

## Usage (caller's view)

Write this section before the type sketch. Show the README or quickstart the consumer reads, plus two or three realistic call sites in their code: what they import, what they call, and what comes back. Derive [Shape](#shape) from this section. When the two disagree, change the sketch to match the usage.

## Shape

The recommended architecture. Give the data structures first, then how data flows through the signatures. Name the decisions the design depends on. State which invariants live in types, where validation lives, and what the system does not do. State what complexity the public interface hides, what stays exposed to callers, and why the interface is no larger. Cite the principle behind each decision by name, for example `per principle-boundary-discipline`, without restating it.

## Synthesis decision

[Arena](../../arena/SKILL.md) fills this in. Record which candidate became the base and why, what came from each other candidate, and what was rejected and why.

## Tradeoffs accepted

One bullet per tradeoff, in the form "we accept X in exchange for Y." Include anything a future reader might take for an oversight, such as what looks like premature optimization or premature simplification.

## Alternatives considered

Required. Name at least one other concrete shape the design rejected, with one line on why it lost. Judge each one on the complexity it exposes to callers and the complexity it hides. List two or three when the design space had real contenders. One is fine when the constraints forced the answer; then write "this was the only viable shape because...". Do not list variants of the same shape, and do not list other runners' candidates here.

## Open questions and risks

Questions the human must answer and risks to flag before implementation starts. Phrase each one as a question, so the human's answer resolves it.

## Next implementation step

One sentence naming the first thing to build against the sketch, right after synthesis or after Phase C sign-off.
