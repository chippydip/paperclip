---
id: subscription-adapter-preserves-orchestration-contract
type: decision
governs:
    - docs/design/interactive-claude-adapter.md
    - server/src/adapters/**
status: current
confidence: high
source: log
decision: |
    A subscription-billed interactive adapter must return the same structured
    execution result the heartbeat service already consumes — usage, cost, session
    id, resume params, an authoritative clear-session signal, and a typed error
    taxonomy (including transient-upstream with a retry-not-before) — and keep the
    existing session model: keyed by (agent, task), cwd-aware (fresh session on cwd
    change), persisted across heartbeats, with one heartbeat run driving one
    user-message turn into a warm, long-lived session. Poisoned-session recovery
    (return clear-session, server drops the row) carries over unchanged.
rationale: |
    Watchdog/liveness, recovery, and resume all depend on this contract regardless
    of transport; a streaming interactive session that didn't decompose into
    discrete per-(agent,task) runs, or that dropped the clear-session/error signals,
    would silently break recovery and watchdog behavior. Mapping one heartbeat to
    one turn against a persistent session preserves the existing resume semantics
    while letting the cloud session stay warm — chosen over inventing a parallel
    long-lived lifecycle that every orchestration consumer would have to be reworked
    to understand.
alternatives_rejected:
    - option: A bespoke streaming lifecycle decoupled from heartbeats
      reason: Orchestration keys resume/recovery/watchdog on discrete per-(agent,task) runs; a parallel model forces every consumer to be reworked.
triggers_review_if: |
    The interactive transport cannot map a heartbeat to a single discrete turn; the
    heartbeat service's result contract or session-resume keying changes; on-disk
    transcript assumptions stop holding on the new transport.
supersedes: null
last_validated: 2026-06
patterns:
    - Adapter returns AdapterExecutionResult with usage/cost/sessionParams/clearSession/errorCode
    - Session resume keyed by (agentId, taskKey) and cwd-aware
    - One heartbeat run drives exactly one user-message turn
    - errorCode taxonomy includes transient_upstream carrying retryNotBefore
    - Poisoned-session error returns clearSession:true so the server drops the row
antipatterns:
    - Fire-and-forget invocation that returns no structured result
    - Long-lived session lifecycle that ignores the (agentId, taskKey) resume key
    - Dropping or swallowing clearSession on a poisoned-session error
---
