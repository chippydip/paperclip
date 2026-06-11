---
id: interactive-adapter-transport-rc-bridge
type: decision
governs:
    - docs/design/interactive-claude-adapter.md
    - server/src/adapters/**
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
    automation. MCP/ACP routes through the SDK/headless surface that bills the
    metered credit pool, so it cannot achieve subscription billing at all. The
    bridge's cost is a private/undocumented client API in a ToS gray zone, accepted
    at low volume with an honest fallback to the metered adapter and same-account OAuth.
alternatives_rejected:
    - option: ConPTY/node-pty TUI scraping
      reason: No structured output or usage capture; ANSI scraping breaks on per-release TUI churn; most adversarial-looking surface automation.
    - option: Channels MCP / ACP
      reason: Routes through the SDK/headless surface, which bills the metered credit pool — does not achieve subscription billing.
triggers_review_if: |
    The mobile-app client API spike (create/send-message shape) fails or the API
    changes incompatibly; ToS sign-off for automating the interactive surface is
    withheld; upstream changes how billing is classified at session ingress.
supersedes: null
last_validated: 2026-06
patterns:
    - Adapter attaches to a remote-control-created cloud session (cse_*) for billing ingress
    - Worker child spawned headless with stream-json input/output
    - Reuses the metered adapter's stream-json parsing rather than a new parser
    - A per-workspace supervisor owns and reuses the remote-control child across restarts
antipatterns:
    - Scraping ANSI/TUI output from a pseudo-terminal
    - Driving Claude through an MCP/ACP channel to obtain subscription billing
    - Treating TTY attachment as the billing signal
---
