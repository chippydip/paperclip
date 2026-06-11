---
id: subscription-surface-spike-conduct
type: process
governs:
    - docs/design/**
status: current
confidence: high
source: log
decision: |
    Probing the subscription/interactive Claude surface (undocumented client APIs,
    concurrency, billing frames) is ToS-gray-zone work that requires board
    authorization before running. It runs against the production subscription OAuth
    identity at low volume — prefer evidence derivable from existing transcripts/logs
    over new live API turns, and escalate only the genuinely human-gated step.
    Captured credentials (OAuth bearers, worker JWTs, account/org/workspace UUIDs)
    are redacted to shapes in any committed artifact; live tokens never enter the
    conversation or the repo.
rationale: |
    Probing draws on the same shared 5h window the live orchestration paces against,
    so the identity choice and probe volume have real blast radius. The board
    authorized the production identity (not an isolated/throwaway login) because most
    findings are artifact-derivable with zero new turns and any live probe is a
    handful of hello turns within "low volume" — and a throwaway login wouldn't
    exercise the real billing window the design depends on. Redacting to shapes keeps
    the evidentiary value (endpoint and frame shapes) while keeping reusable
    credentials out of a tracked PR doc, where the secrets contract that governs
    adapter config does not reach.
alternatives_rejected:
    - option: Probe against an isolated/throwaway OAuth login
      reason: Wouldn't exercise the real subscription window the design depends on; the board-approved checklist directed the existing production rc environment.
triggers_review_if: |
    A future probe would exceed "low volume" (sustained or high-turn automation);
    board authorization for surface probing is withheld or revoked; per-agent
    subscription identities become available, removing the shared-window risk.
supersedes: null
last_validated: 2026-06
patterns:
    - Captured tokens written as redacted shapes (e.g. Bearer sk-ant-oat01-…[REDACTED]) in committed docs
    - Findings derived from existing transcripts/logs before any new live API turn
antipatterns:
    - Live OAuth bearer, worker JWT, or account UUID printed into the conversation or committed to the repo
    - Automated probing of the interactive surface without board authorization
mechanical_checks:
    - description: Unredacted Anthropic OAuth access token in a committed doc
      regex: sk-ant-oat\d+-[A-Za-z0-9_-]{20,}
      severity: contradicts
      files: docs/**
---
