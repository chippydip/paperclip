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
    The subscription adapter authenticates via first-party Anthropic OAuth login in a
    dedicated, isolated config directory and must never inject an Anthropic API key.
    This is a hard ingress requirement, not only a billing preference: the cloud-session
    ingress rejects API-key auth outright and requires an OAuth login. Sensitive env
    stays secret-ref typed, and Paperclip runtime-owned keys are applied last in the
    fixed merge order.
rationale: |
    Billing follows the auth/ingress path: the API-key path bills the metered credit
    pool, while the subscription path requires OAuth and a config dir that an
    API-key flow would override. Beyond billing, the ingress itself refuses to open a
    cloud session under API-key auth, so an injected key doesn't just re-meter the
    run — it breaks it. An isolated config dir also keeps the subscription OAuth login
    from colliding with other agents' API-key or OpenRouter configurations — the same
    isolation those agents already rely on in reverse to protect this login.
alternatives_rejected:
    - option: Reuse a shared config dir or inline an Anthropic API key
      reason: Switches billing to the metered pool, is rejected by the cloud-session ingress, and risks clobbering other agents' auth in the shared directory.
triggers_review_if: |
    Upstream decouples billing classification from the auth path or lets cloud
    sessions open under API-key auth; the subscription OAuth flow stops requiring an
    isolated config dir; the secret-ref env contract or merge order changes.
supersedes: null
last_validated: 2026-06
patterns:
    - Subscription adapter points CLAUDE_CONFIG_DIR at an isolated OAuth-login directory
    - Auth is the first-party OAuth access token (scope user:sessions:claude_code); a setup-token OAuth token of the same scope also works
    - Sensitive env supplied as secret_ref rows; runtime-owned keys merged last
antipatterns:
    - Injecting ANTHROPIC_API_KEY into a subscription-billed adapter
    - Sharing the subscription config dir with API-key or OpenRouter agents
    - Inline plaintext secret in adapter env instead of a secret reference
---

## Spike validation (GOLA-5, 2026-06-11)

The cloud-session ingress hard-rejects API-key auth: it throws "Cloud sessions are
only available on the first-party Anthropic API provider" and "API key authentication
is not sufficient. Please run /login". The accepted credential is the `sk-ant-oat01…`
OAuth access token (scope `user:sessions:claude_code`); a `claude setup-token` OAuth
token of the same scope works equally, while a raw API key does not. This promotes the
no-API-key rule from a billing choice to a precondition for the transport opening at all.
