---
id: claude-remote-per-run-worker-lifecycle
type: decision
governs:
    - packages/adapters/claude-remote/**
    - docs/design/interactive-claude-adapter.md
status: provisional
confidence: medium
source: log
decision: |
    The b1 self-worker runs one supervised worker child per execute() run: claim a
    worker token, spawn the headless child against the resumed-or-fresh cloud session,
    hold its stdin open for the child's lifetime, drive exactly one user-message turn,
    then tear it down (close stdin → grace → kill). No worker state is shared across
    runs. A mid-turn worker death before the turn's terminal result is retryable
    (transient-upstream, no clear-session — the cloud session survives server-side and
    resumes); spawn failure is an environment error. A long-lived warm child is a
    deliberate follow-up, not Day 1.
rationale: |
    Per-run child over a persistent warm child keeps the one-heartbeat-one-turn
    mapping clean and avoids cross-run child state, and is the minimal viable subset
    of the transport decision's "per-workspace supervisor owns the child across
    restarts" target. A warm child would amortize spawn cost but adds reconciliation
    between a persistent process and discrete heartbeat turns — deferred until the
    per-run loop is proven. Mid-turn death is mapped retryable rather than poisoning
    because the cloud session is intact server-side and resumable, so clearing it
    would discard a recoverable session.
alternatives_rejected:
    - option: Long-lived warm worker child reused across turns (acpx-style)
      reason: Amortizes spawn cost but forces reconciling a persistent process with discrete one-turn heartbeats; deferred until the per-run loop is proven.
    - option: Map mid-turn worker death to clear-session / poison
      reason: The cloud session survives the child server-side and resumes, so poisoning it would discard a recoverable session.
triggers_review_if: |
    The warm long-lived child follow-up lands (rotating this to the supervisor model);
    a mid-turn worker death is found to corrupt the cloud session server-side (would
    require clear-session); the one-heartbeat-one-turn mapping stops holding.
supersedes: null
last_validated: 2026-06
gaps_identified:
    - '[[interactive-adapter-transport-rc-bridge]]''s pattern ''per-workspace supervisor owns the worker child across restarts'' describes the warm-child target, not this Day-1 per-run model; reconcile when the follow-up lands'
    - sibling adapter decisions still govern only server/src/adapters/** though the code shipped at packages/adapters/claude-remote — governs being extended in this capture
patterns:
    - One worker child spawned and torn down within a single execute() run
    - Child stdin held open for the child's lifetime, closed on teardown
    - Mid-turn worker death maps to transient-upstream without clear-session
    - Spawn failure maps to an environment-shaped error
antipatterns:
    - Worker child reused across multiple execute() runs in Day 1
    - Poisoning or clearing the cloud session on worker child death
    - Leaving worker children running after the turn's terminal result is observed
---

The result channel itself (the CCR-v2 client events stream, not the worker child
stdout) is owned by [[interactive-adapter-transport-rc-bridge]] — this decision is about
the child process lifecycle and failure taxonomy, and phrases failure mapping in terms
of "the turn's terminal result observed" regardless of which leg carries it.
