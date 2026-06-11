---
id: claude-remote-session-rotate-not-a-state
type: decision
governs:
    - packages/adapters/claude-remote/**
status: current
confidence: medium
source: log
decision: |
    Session "rotate" in the remote adapter is not a third lifecycle state alongside
    resume and clear — it is minting a fresh cloud session under the SAME
    (agentId, taskKey) resume key, fired by exactly the resume-eligibility failures
    claude_local already uses: no stored session, cwd changed, prompt-bundle key
    changed, or an unknown/archived-session upstream error (which additionally returns
    clear-session). The resume keying and recovery semantics of the orchestration
    contract are preserved verbatim.
rationale: |
    Defining rotate as fresh-session-under-the-same-key lets the cloud-session
    transport reuse claude_local's existing resume-eligibility predicate unchanged,
    inheriting proven keying instead of inventing parallel triggers. A distinct rotate
    state could mint sessions outside the (agentId, taskKey) keying that resume,
    recovery, and watchdog all depend on.
alternatives_rejected:
    - option: Treat rotate as an independent lifecycle state with its own triggers
      reason: Risks minting sessions off the (agentId, taskKey) key, breaking the resume/recovery keying the orchestration contract guarantees.
triggers_review_if: |
    The remote adapter's resume-eligibility predicate diverges from claude_local; a
    rotate trigger appears that isn't a resume-eligibility failure; the (agentId,
    taskKey) keying changes.
supersedes: null
last_validated: 2026-06
patterns:
    - Fresh cloud session minted under the existing (agentId, taskKey) key
    - Rotate triggers are exactly claude_local's resume-eligibility failures
    - Unknown/archived-session error returns clear-session alongside the fresh session
antipatterns:
    - A standalone rotate state that mints sessions off the (agentId, taskKey) key
    - Rotate triggered by a condition outside the resume-eligibility predicate
---

This refines [[subscription-adapter-preserves-orchestration-contract]] for the cloud
transport without changing its resume/recovery contract.

Now the `governs` extensions on the existing branch-local adapter decisions (content otherwise preserved verbatim — only the new package path is added):
