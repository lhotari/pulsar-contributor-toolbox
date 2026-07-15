---
name: pip-design
description: Design or refine an Apache Pulsar PIP (Pulsar Improvement Proposal) from a draft into a votable, minimal, 5-year-durable proposal. Runs multi-model multi-viewpoint reviews, an iterative minimalism-refinement loop to a fixpoint, and (when the PIP has a reference implementation) the full design-doc + code + CI pipeline. Use when asked to design a PIP, review/harden a PIP draft, or drive a proposal to "nothing left to take away."
argument-hint: "<path-to-pip-draft.md> [--impl <impl-branch-or-worktree>] [--reviewers fable,opus,codex]"
allowed-tools: Bash(*), Read, Write, Edit, Glob, Grep, Agent, Skill, SendMessage
---

# PIP Design

Take a Pulsar Improvement Proposal from a rough draft to a proposal that is **votable, minimal, and built to hold for 5+ years** — through disciplined multi-model review and an iterative minimalism refinement loop.

> *"Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away."* — Antoine de Saint-Exupéry
>
> *"Simple can be harder than complex. You have to work hard to make your thinking clean to make it simple."* — Steve Jobs

These two quotes are the skill's north star. Minimalism is the goal; the work of getting there is making the design's thinking clean.

## When to use

- A PIP draft exists (even rough) and needs to be hardened into something the community can vote on.
- A design has grown across revisions and needs a subtractive pass ("what can we remove?").
- You want independent, adversarial review of interface decisions that must live for years.

## The core loop

Design refinement is **iterative to a fixpoint**, not one-shot. Repeat REVIEW → DECIDE → APPLY → VERIFY until a full review round surfaces nothing new.

### 1. Understand the draft against the code
Read the PIP end to end. If it has (or claims) a reference implementation, **verify every claim against the actual code** — grep the shipped types and their *production call sites*, not just declarations. Do not trust prose that says "X is used" or "Y is a well-known extension point"; confirm a real consumer exists. Fabricated or aspirational claims are the first thing to fix.

### 2. Multi-model, multi-viewpoint review
Run **independent reviews from different models, each with a distinct lens.** Convergence across models = highest confidence; a lone finding is a hypothesis to verify.

Suggested panel (adapt to what's available):
- **Fable 5** — design coherence + subtractive minimalism (smallest sufficient type set; does each element pull its weight in the whole shape?).
- **Opus 4.8 (xhigh / think hard)** — durability + implementability (which decisions are safe 5-year bets vs churn-risk; premature generalization; missing invariants that force a later break; third-party-implementer traps).
- **Codex (GPT-5.5, high reasoning)** — adversarial ("argue the design is bigger than it needs to be"; security; backward-compat).

Give each reviewer the SAME lens questions + a shared list of seed candidates, but let each bring its angle. Have them return structured verdicts: **CUT / RESHAPE / KEEP** per element, with rationale, an additive add-back path, and the tradeoff. (Run reviewers as parallel subagents; Codex via `codex exec -c model_reasoning_effort="high"`.)

Run the reviewers READ-ONLY. They analyze; you decide.

### 3. Decide — the minimalism judgment
For every public type / method / field / enum value / resolved decision, ask:
1. Is there a **real in-tree consumer today**, or is it speculative generality?
2. If removed, what concretely breaks — and could an existing element meet the need?
3. Is this exact shape a safe 5-year bet, or a guess likely to churn (forcing a compat break)?
4. Can a future revision add it back **additively** when a real need appears? (If yes, removal now is safe — a shipped public API is forever; add-back is cheap.)

**The deciding principle (earned across a real PIP):**
> **Cut what carries _contract weight_ — an interaction rule, a merge precedence, a duplicate path — when it has no consumer. KEEP zero-rule _projections_ that serve the audience the SPI exists for (third-party implementers), safety guards together with their escape valves, and service seams that have a consuming twin.**

Corollaries:
- A **lying accessor** (always returns a constant / fabricated value because the surrounding seam can't populate it) is worse than absent — cut it.
- A **duplicate path** ("a second way to express what the design already expresses once") — cut one.
- **"Wired + functional but no in-tree producer" does NOT by itself clear the cut bar** for an SPI meant for third parties. What clears it is *no-consumer AND contract-weight*.
- **Guard against manufactured minimalism.** Removing a safety guard, a zero-rule projection serving the SPI's audience, fixed RFC/standard vocabulary, or a shape whose removal *forces a future break* is not simplification — it manufactures traps and gaps. Do not invent findings to seem thorough.
- Grep **production call sites**, not declarations — the sharpest cuts come from seeing what values callers actually pass (e.g. a port field that every caller sets to 0).

### 4. Apply — the full pipeline
Each accepted change runs the whole pipeline so the proposal and its implementation never drift:
- **Design doc**: make the edit AND write a **decision record** — for a cut: *what / why / additive add-back path / tradeoff*; for a contested keep: the rationale. Kept-and-why is as valuable as cut-and-why. Maintain an "honesty list" of deliberate keeps with zero/low consumers so a later pass doesn't re-litigate them.
- **Code** (if there's a reference impl): make the change minimal and surgical; STOP and report if a "dead" element turns out load-bearing.
- **Verify**: compile + the affected tests; for anything wire-observable (auth bytes, TLS handshake, HTTP encoding) prove **wire-equivalence** before "exercising" a speculative element — if it can't be preserved, cut instead.

### 5. Verify the whole & re-review (fixpoint)
Re-run the multi-model review on the refined design. **Keep iterating until a full round returns no agreed CUT/RESHAPE that survives scrutiny.** That is the fixpoint — "nothing left to take away." Each round typically finds less; when the reviewers who drove the earlier cuts now find nothing, you're there. Confirm the **major interface decisions** hold in shipped code (not just prose), and that no remaining shape forces a future backward-incompatible break.

## If the PIP has a reference implementation + CI

Keep the implementation green throughout, and decompose it for review:
- **Split into a stacked PR series** where each chunk builds on the last and is individually CI-triggerable. Defer deletions to the last chunk so every earlier chunk is forward-reference-free (a clean wholesale checkout from the green monolith).
- **Prove equivalence**: the last chunk's tree must equal the monolith (minus any excluded log), byte-for-byte. This is the correctness gate for the decomposition.
- **CI discipline**: verify the *full* local gate before pushing (not a subset); triage failures real-vs-flake by the actual failing test + its stack, not the group name; rerun known flakes; a sweeping default change (e.g. secure-by-default) breaks tests only CI's full matrix surfaces — expect a few principled iterations.
- **Orchestration**: one worktree owner at a time; use the raw git binary for ref/SHA-critical ops if a proxy tool rewrites them; keep a running implementation log of every decision + tradeoff.

## Deliverable

A PIP where the surface is small enough to defend, every remaining element earns its place with a real consumer (or is a documented safety-guard / projection / seam), every deferred capability has a clean additive path, the major decisions are verified 5-year-durable, and the decision records make the "why" auditable. Simple achieved — nothing to add, nothing to take away.
