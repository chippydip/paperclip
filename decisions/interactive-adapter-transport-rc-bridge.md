---
id: interactive-adapter-transport-rc-bridge
type: decision
governs:
    - docs/design/interactive-claude-adapter.md
    - server/src/adapters/**
    - packages/adapters/claude-remote/**
status: provisional
confidence: medium
source: log
decision: |
    The interactive, subscription-billed adapter drives Claude by creating and
    streaming a cloud session through the remote-control ingress — acting as the
    mobile-app client against a supervised, per-workspace remote-control server —
    rather than scraping an interactive terminal. Subscription billing comes from
    the session ingress, not from an attached TTY, so the worker stays headless and
    emits the same structured stream-json the metered adapter already speaks.
rationale: |
    Billing classification keys off how the session was created, not whether a TTY
    is attached: a remote-control worker is itself spawned headless yet bills to the
    subscription window because it attaches to an ingress-created cloud session. So
    TUI scraping buys nothing the bridge doesn't — and costs brittle ANSI parsing,
    no usage capture, per-release TUI churn, and the most adversarial-looking
    automation. ACP routes through the SDK/headless surface that bills the metered
    credit pool, so it cannot achieve subscription billing. Claude Code Channels
    (research preview) push events into an existing session and inherit that host
    session's billing surface — subscription only if a persistent interactive host
    is kept alive — and offer no session lifecycle, no acknowledged delivery, and
    no usage/cost surface, with custom channels gated behind a development flag
    for the duration of the preview. The bridge's cost is a private/undocumented
    client API in a ToS gray zone, accepted at low volume with an honest fallback
    to the metered adapter and same-account OAuth.
alternatives_rejected:
    - option: ConPTY/node-pty TUI scraping
      reason: No structured output or usage capture; ANSI scraping breaks on per-release TUI churn; most adversarial-looking surface automation.
    - option: Claude Code Channels (research preview)
      reason: Inherits the host session's billing surface (no subscription-billed headless host exists); no session lifecycle or protocol-level result/usage contract (unacknowledged notifications, prompt-enforced replies, wake batching); custom channels require a development flag during the preview.
    - option: ACP (acpx)
      reason: Routes through the SDK/headless surface, which bills the metered credit pool — does not achieve subscription billing.
    - option: Managed-agents platform API (`claude agents`)
      reason: A documented session API, but a separate Anthropic-hosted execution surface (vaults/resources) on a different create path — it does not drive the local-workspace bridge or lower the bridge's API-drift risk.
triggers_review_if: |
    The captured client session API changes incompatibly; ToS sign-off for
    automating the interactive surface is withheld; upstream changes how billing is
    classified at session ingress; the post-June-15 usage dashboard shows rc-driven
    turns bill to the metered credit pool rather than the subscription window;
    Channels graduate from research preview with a stable custom-channel path, or
    the spike probe shows a channels-hosted -p session bills to the subscription
    window.
supersedes: null
last_validated: 2026-06
patterns:
    - Adapter attaches to a remote-control-created cloud session (cse_*) for billing ingress
    - Worker child spawned headless with stream-json input/output
    - Reuses the metered adapter's stream-json parsing rather than a new parser
    - A per-workspace supervisor owns the worker child (self-run or reused rc child) across restarts
antipatterns:
    - Scraping ANSI/TUI output from a pseudo-terminal
    - Expecting a channel/MCP push surface to change the host session's billing classification
    - Treating TTY attachment as the billing signal
    - Routing through the managed-agents platform API and assuming it drives the local-workspace bridge
---

## Spike validation (GOLA-5, 2026-06-11)

The client session protocol was captured from the binary and driven end-to-end
with raw HTTP (no official client): create → worker-claim → attach over SSE →
message all returned success. Transport viability is confirmed; the build stays a
**conditional GO** behind the post-June-15 pool-attribution gate (see
[[subscription-billing-cost-representation]]).

**Worker ownership (b1 vs b2).** Paperclip running its own headless worker (b1) is
proven viable — a self-minted worker token connected to the cloud session. Reusing
the stock remote-control server's worker (b2) additionally needs an undocumented,
server-side environment-dispatch binding: API-created sessions come back unbound and
are not picked up by a specific environment's work/poll, and the binding is not a
create-body field. Default to b1 unless that binding is captured; the worker-claim
itself required no trusted-device token.

## Day 1 closed-loop confirmation (GOLA-8, 2026-06-11)

b1 is now driven end-to-end: create → worker-claim → spawn worker child → send
message → terminal `result` parsed, plus multi-turn resume within one `cse_*`
session. Two captured-contract corrections (see the design doc §7):

- **Worker registration is the CCR-v2 path.** The worker aborts with
  `missing_epoch` unless `CLAUDE_CODE_WORKER_EPOCH` (the `worker_epoch` string
  from the bridge claim) and `CLAUDE_CODE_USE_CCR_V2=1` are set alongside
  `CLAUDE_CODE_SESSION_ACCESS_TOKEN` and `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1`.
- **The turn's events arrive on the client events stream**
  (`GET /v1/code/sessions/{id}/events/stream`), not the worker child's stdout —
  the CCR-v2 worker POSTs events back to the cloud session. The payloads are the
  same stream-json, so the "reuse the metered adapter's parser" pattern holds. The
  per-run worker child lifecycle that consumes this transport is
  [[claude-remote-per-run-worker-lifecycle]].
