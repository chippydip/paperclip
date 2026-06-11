# @paperclipai/adapter-claude-remote

## 0.1.0 (GOLA-8 — Day 1 adapter core)

Initial scaffold of the `claude_remote` adapter: a client of the remote-control
cloud-session protocol that bills to the Max subscription windows instead of the
metered `--print` credit pool.

- **Client module** (`server/client.ts`) for the captured session protocol:
  `POST /v1/code/sessions` (create), `POST /{id}/bridge` (worker-claim → worker
  JWT + epoch, 4h TTL), `POST /{id}/events` (user message send),
  `GET /{id}/events/stream` (SSE event stream with seq-replay reconnect),
  `POST /{id}/archive`. Subscription OAuth (`sk-ant-oat01…`) only; API keys are
  rejected by the cloud ingress and never injected.
- **b1 self-worker supervisor** (`server/worker.ts`): spawns the captured
  `claude --print --sdk-url …` worker child and holds its stdin open for the
  child's lifetime (a bare `--print` child exits on stdin EOF before the cloud
  message is delivered — the pitfall the GOLA-5 spike hit).
- **`execute()`** (`server/execute.ts`): `(agent, task)`-keyed `cse_*` session
  resume/rotate, prompt rendering + instructions inlining, result parsing via
  claude-local's `parseClaudeStreamJson`, `billingType: "subscription"`,
  `rate_limit_event` → `retryNotBefore` on window exhaustion.
- **Quota bookkeeping** (`server/rate-limit-state.ts`): records the latest
  `rate_limit_event` (`five_hour`, `resetsAt`) and surfaces it via
  `getQuotaWindows` alongside the OAuth usage windows.

### Two corrections to the captured contract (verified live, GOLA-8)

1. **Worker registration is the CCR-v2 path.** The worker child aborts with
   `worker registration failed (missing_epoch)` unless
   `CLAUDE_CODE_WORKER_EPOCH` (the `worker_epoch` string from the claim, observed
   as `"1"`) and `CLAUDE_CODE_USE_CCR_V2=1` are set, in addition to
   `CLAUDE_CODE_SESSION_ACCESS_TOKEN` and `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1`.
2. **The turn's events arrive on the client events stream, not the worker child
   stdout.** Under CCR-v2 the worker POSTs assistant/result/`rate_limit_event`
   events back to the cloud session; its own stdout is startup diagnostics only.
   The adapter reads the turn from `GET /v1/code/sessions/{id}/events/stream` —
   the payloads are identical stream-json, so `parseClaudeStreamJson` is reused
   verbatim.

Day 2 (follow-up): registry registration, per-environment concurrency semaphore,
session teardown polish, docs page, `sessionManagement`/compaction wiring.
