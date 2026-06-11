---
id: interactive-adapter-concurrency-bounded-per-environment
type: decision
governs:
    - docs/design/interactive-claude-adapter.md
    - server/src/adapters/**
status: provisional
confidence: medium
source: check
decision: |
    Concurrent subscription-billed sessions on one OAuth login are allowed but
    bounded per bridge environment: the remote-control surface natively
    multiplexes sessions on a single login (--capacity, default 32), so the
    adapter uses a per-environment semaphore rather than host-wide
    serialization. The shared 5h/7d usage window is arbitrated by quota-window
    backoff (retryNotBefore = rate_limit_event.resetsAt) and the
    metadata.billing = anthropic-subscription pacer tag, not by single-flight.
rationale: |
    The remote-control product is designed for multiple simultaneous sessions
    on one subscription identity (the mobile app does exactly this), so
    serializing all agents host-wide would discard throughput the surface
    already supports safely. Sessions are isolated per cse id; the only truly
    shared resources are the auth token (owned and refreshed by the rc server)
    and the usage window, which is a pacing problem, not a correctness problem.
alternatives_rejected:
    - option: Single-flight per host (serialize all turns across agents)
      reason: Discards concurrency the rc surface natively supports; sessions do not share mutable state, so serialization buys no correctness.
    - option: Unbounded concurrency
      reason: Session creation fails past environment capacity and burst usage exhausts the shared 5h window unpredictably; a bound plus window-aware backoff is needed.
triggers_review_if: |
    Spike testing shows cross-session interference on one login; Anthropic
    changes capacity or rate-limit semantics for remote-control environments;
    per-agent subscription identities become available.
supersedes: null
last_validated: 2026-06
patterns:
    - Per-environment semaphore caps in-flight sessions below rc --capacity
    - Window exhaustion maps to transient_upstream with retryNotBefore=resetsAt
antipatterns:
    - Host-wide serialization of all subscription-billed turns
    - Creating sessions without checking environment capacity or window state
---

## Spike validation (GOLA-5, 2026-06-11)

The rc server registers `max_sessions: 32`, confirming the `--capacity` multiplexing
premise and the default the semaphore caps below. Two sessions created simultaneously
both returned `status:active` with no observed interference. A full two-worker
concurrent spawn through the stock rc server was not demonstrated — blocked by the
unresolved b2 environment-dispatch binding (see
[[interactive-adapter-transport-rc-bridge]]) — so the cross-session-interference
trigger remains only partially exercised.
