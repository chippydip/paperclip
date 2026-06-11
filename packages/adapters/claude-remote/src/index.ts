export { models, modelProfiles } from "@paperclipai/adapter-claude-local";

export const type = "claude_remote";
export const label = "Claude Code (remote session)";

export const agentConfigurationDoc = `# claude_remote agent configuration

Adapter: claude_remote

Drives Claude through the remote-control cloud-session ingress (the surface the
mobile app and claude.ai/code use), so turns bill to the **Max subscription
5-hour/7-day windows** instead of the metered \`--print\` credit pool. The adapter
creates a \`cse_*\` cloud session, claims a worker token, spawns its own headless
worker child attached to that session, sends the heartbeat prompt as a user
message, and parses the same stream-json output \`claude_local\` parses.

When to use claude_remote vs claude_local:
- Use **claude_remote** for heavy-tier subscription-billed agents (e.g. Fable)
  once headless \`--print\` bills to the metered credit pool (June 15, 2026).
- Use **claude_local** for API-key / OpenRouter-routed agents, Bedrock, or as
  the fallback when the captured session protocol drifts (this adapter's
  protocol is private and undocumented; config-only switch back is the
  designed degradation path).

Requirements:
- A claude.ai subscription OAuth login on the Paperclip host
  (\`~/.claude/.credentials.json\` with \`claudeAiOauth.accessToken\`). A raw
  \`ANTHROPIC_API_KEY\` does NOT work for cloud sessions and is never injected.
- Local execution only (v1). Remote execution targets are not supported.

Core fields:
- cwd (string, optional): default absolute working directory for the worker child
- instructionsFilePath (string, optional): absolute path to a markdown instructions file; injected inline into the first user message of each fresh session
- model (string, optional): Claude model id, passed in the session create config
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): rendered once per fresh session before the wake prompt
- command (string, optional): defaults to "claude" (worker child binary)
- baseUrl (string, optional): defaults to "https://api.anthropic.com"
- clientPlatform (string, optional): anthropic-client-platform header value for client calls; defaults to "claude_code_remote"
- env (object, optional): KEY=VALUE environment variables for the worker child. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are always stripped (subscription OAuth only).

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no adapter-level timeout)
- graceSec (number, optional): worker teardown grace period in seconds (default 20)

Session model:
- One cloud session (\`cse_*\`) per (agent, task), stored in sessionParams as
  { cseSessionId, cwd, promptBundleKey }. A heartbeat run is one user-message
  turn awaited until the worker's \`result\` event. Fresh sessions are minted when
  there is no stored session, the cwd or prompt bundle changed, or the stored
  session is unknown/archived server-side (clearSession).
- rate_limit_event frames from the worker feed quota bookkeeping; exhausted
  windows map to errorFamily "transient_upstream" with retryNotBefore set to
  the window reset time.
`;
