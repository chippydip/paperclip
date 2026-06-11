---
id: subscription-adapter-oauth-not-api-key
type: decision
governs:
    - docs/design/interactive-claude-adapter.md
    - server/src/adapters/**
status: current
confidence: high
source: check
decision: |
    The subscription adapter authenticates via OAuth login in a dedicated, isolated
    config directory and must never inject an Anthropic API key — an API key flips
    the session back to metered/API billing and defeats the adapter's entire
    purpose. Sensitive env stays secret-ref typed, and Paperclip runtime-owned keys
    are applied last in the fixed merge order.
rationale: |
    Billing follows the auth/ingress path: the API-key path bills the metered credit
    pool, while the subscription path requires OAuth and a config dir that an
    API-key flow would override. An isolated config dir also keeps the subscription
    OAuth login from colliding with other agents' API-key or OpenRouter
    configurations — the same isolation those agents already rely on in reverse to
    protect this login.
alternatives_rejected:
    - option: Reuse a shared config dir or inline an Anthropic API key
      reason: Switches billing to the metered pool and risks clobbering other agents' auth in the shared directory.
triggers_review_if: |
    Upstream decouples billing classification from the auth path; the subscription
    OAuth flow stops requiring an isolated config dir; the secret-ref env contract
    or merge order changes.
supersedes: null
last_validated: 2026-06
patterns:
    - Subscription adapter points CLAUDE_CONFIG_DIR at an isolated OAuth-login directory
    - Sensitive env supplied as secret_ref rows; runtime-owned keys merged last
antipatterns:
    - Injecting ANTHROPIC_API_KEY into a subscription-billed adapter
    - Sharing the subscription config dir with API-key or OpenRouter agents
    - Inline plaintext secret in adapter env instead of a secret reference
---
