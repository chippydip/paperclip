---
id: subscription-billing-cost-representation
type: decision
governs:
    - docs/design/interactive-claude-adapter.md
    - server/src/adapters/**
status: provisional
confidence: medium
source: log
decision: |
    Subscription-billed runs record cost informationally (parsed dollar cost when
    the stream emits it, else zero) and carry a billing-mode discriminant
    (subscription vs metered) so the dollar hard-limit auto-pause excludes them. For
    subscription agents the upstream five-hour rate-limit reset time — not a dollar
    budget — is the quota-window signal, and it feeds the retry-not-before backoff.
rationale: |
    Subscription work draws on a flat usage window with no meaningful per-call
    dollar cost, so feeding it into credit-budget math would spuriously trip the
    hard-limit auto-pause. A discriminant lets the same cost/usage-rollup and budget
    machinery serve both billing modes without forking it. Tracking the subscription
    window via the upstream rate-limit reset gives subscription agents a real
    exhaustion signal in place of the dollar budget that no longer applies — chosen
    over fabricating synthetic dollar costs (numbers the model doesn't produce) or
    omitting the runs entirely (which would lose useful token/usage rollups).
alternatives_rejected:
    - option: Fabricate synthetic per-call dollar cost for subscription runs
      reason: Invents numbers the flat-subscription model doesn't produce and still mixes them into credit-budget enforcement.
    - option: Omit subscription runs from the cost/usage rollup entirely
      reason: Loses token/usage rollups that are useful independent of dollar billing and break per-run accounting.
triggers_review_if: |
    Budget enforcement gains a path that ignores the discriminant; the upstream
    rate-limit event stops carrying a usable reset time; subscription billing starts
    emitting reliable per-call dollar costs.
supersedes: null
last_validated: 2026-06
gaps_identified:
    - governs may need to include the budget/auto-pause enforcement module (outside the adapter tree) — the discriminant only matters if enforcement reads it
patterns:
    - Cost/usage rollup row carries a subscription-vs-metered billing discriminant
    - Dollar hard-limit enforcement skips runs flagged subscription-billed
    - Upstream rate-limit reset time drives retryNotBefore / quota-window tracking
antipatterns:
    - Subscription runs counted against the dollar credit budget
    - Synthetic per-call dollar cost fabricated for flat-subscription work
---
