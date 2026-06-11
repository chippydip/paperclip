---
id: claude-remote-worker-jwt-ephemeral
type: decision
governs:
    - packages/adapters/claude-remote/**
status: provisional
confidence: medium
source: log
decision: |
    The b1 worker token (bridge-claim JWT) is minted fresh per execute() run from the
    session bridge-claim, held in memory only, and handed to the worker child solely
    through its environment — never persisted to session params, disk, logs, or
    fixtures. No refresh path exists because the token's lifetime (≈4h) far exceeds a
    bounded run, so it cannot expire mid-turn. JWT-shaped strings are redacted to a
    shape in any committed artifact, the same posture the OAuth bearer already carries.
rationale: |
    Per-run minting plus in-memory-only handling keeps a reusable bearer out of tracked
    session state for no cost — the claim is cheap and the token is short-lived — over
    caching it across runs. A refresh path would be untested dead code Day 1 because the
    4h TTL dwarfs the run timeout. Redacting JWT shapes extends the spike-conduct
    redaction rule, whose mechanical check only catches sk-ant-oat tokens, to the worker
    JWT so the second captured credential class can't land in a tracked artifact either.
alternatives_rejected:
    - option: Persist or cache the worker JWT across runs
      reason: Puts a reusable bearer into tracked session state for no gain; per-run mint is cheap and the token is short-lived.
    - option: Build a JWT refresh path in Day 1
      reason: The 4h TTL far exceeds a bounded run, so it can't expire mid-turn; refresh would be untested dead code.
triggers_review_if: |
    Worker runs can outlive the JWT TTL (would need a refresh path); the bridge-claim
    stops returning a short-lived token; a warm long-lived child reuses one token across
    many turns.
supersedes: null
last_validated: 2026-06
patterns:
    - Worker JWT minted per run from the session bridge-claim
    - Worker JWT passed to the child only through its environment
    - JWT-shaped strings redacted to a shape in committed artifacts
antipatterns:
    - Worker JWT written to session params, disk, logs, or fixtures
    - A JWT-refresh code path present in Day 1
    - Unredacted eyJ… JWT committed to the repo
---

See [[subscription-surface-spike-conduct]] for the parent redaction rule and
[[subscription-adapter-oauth-not-api-key]] for the OAuth bearer this token sits beside.
