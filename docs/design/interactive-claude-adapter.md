---
title: "Design: Interactive Claude Adapter (subscription-billed sessions)"
status: draft
issue: GOLA-3
date: 2026-06-10
---

# Interactive Claude Adapter — Design

## 1. Problem and context

From **June 15, 2026**, headless `claude --print` — the surface the existing `claude_local`
adapter spawns — bills to a separate **$200/month credit pool** instead of the Max
subscription's 5-hour/7-day windows. Interactive surfaces (terminal sessions,
remote-control spawns) stay on subscription.

`claude_local`'s billing premise is therefore inverted for heavy-tier work: today
`resolveClaudeBillingType()` reports `"subscription"` whenever no `ANTHROPIC_API_KEY` is
set (`packages/adapters/claude-local/src/server/execute.ts:130`), but after June 15 the
*surface* (headless `--print`), not the credential, decides which pool is drawn from.
We want an adapter that drives Claude through a **subscription-billed interactive
surface** so heavy agent work keeps drawing from the weekly window, while cheap/
coordinator work stays on OpenRouter-routed `claude_local`.

This document is design-only (no implementation). It evaluates four approaches and
recommends one with a ~2-day build plan.

### Constraints inherited from the adapter architecture

These come from `docs/adapters/creating-an-adapter.md`, the `claude_local`
implementation, `server/src/adapters/registry.ts`, and the heartbeat service. Any
interactive adapter must satisfy all of them:

| Constraint | Where it's pinned |
|---|---|
| Return the full `AdapterExecutionResult` contract: `usage`, `costUsd`, `billingType`, `sessionParams`, `sessionDisplayId`, `clearSession`, `errorCode` taxonomy (incl. `errorFamily: "transient_upstream"` + `retryNotBefore`) | `packages/adapter-utils/src/types.ts:104-141`, `claude-local/src/server/execute.ts:846-974` |
| Session continuity keyed on `(companyId, agentId, adapterType, taskKey)`, persisted in `agent_task_sessions`, cwd-aware, invalidated on prompt-bundle change | `server/src/services/heartbeat.ts:4501-4547`, `claude-local/src/server/execute.ts:595-650` |
| Usage/cost rollups into `cost_events` (provider/biller/billingType/model/tokens/costCents) and `agent_runtime_state`; budget hard-limit auto-pause consumes these | `server/src/services/costs.ts`, `heartbeat.ts:7586-7626`, SPEC §6 |
| Headless autonomy: no interactive approval prompts may block a run (`--dangerously-skip-permissions` / `bypassPermissions` today) | `claude-local/src/server/permissions.ts` |
| Skills/instructions injection without writing into the agent's cwd (prompt bundle + `--add-dir` today) | `claude-local/src/server/prompt-cache.ts` |
| No-remote-git contract: cwd is the only cross-run persistence boundary; never `git push` from adapter code | `packages/adapters/AUTHORING.md`, `creating-an-adapter.md` |
| Error classification drives recovery: unknown-session → retry fresh + `clearSession`; transient upstream (429/5h-limit/weekly-limit) → `retryNotBefore` | `claude-local/src/server/parse.ts:132-415` |

Existing infrastructure that is reusable: `parseClaudeStreamJson()` and the whole
error-detector family in `claude-local/src/server/parse.ts`; the acpx-local warm-handle
pattern for processes that outlive a single run (`packages/adapters/acpx-local`);
the openclaw-gateway adapter as precedent for a network-attached (WebSocket/SSE)
execution surface; `local-service-supervisor.ts` for long-lived background services.

---

## 2. How remote-control actually works (research findings)

Primary sources: debug logs at `C:/Users/cfbra/AppData/Local/Temp/rc-*.log` (live
registration + session flow from the rc server running on this machine) and
`claude remote-control --help` (binary v2.1.172).

**Registration.** `claude remote-control` registers a *bridge environment*:

```
POST https://api.anthropic.com/v1/environments/bridge
>>> {"machine_name":"STARFORGE","directory":"C:\\Users\\cfbra\\Projects","branch":"HEAD",
     "git_repo_url":null,"max_sessions":32,"metadata":{"worker_type":"claude_code"}}
<<< {"environment_id":"env_01...","organization_uuid":"...","environment_secret":"[REDACTED]"}
```

The environment id is persisted in `~/.claude/projects/<encoded-dir>/bridge-pointer.json`
and **reused across server restarts** (the log shows reuse of a 30-day-old env id). Auth
is the subscription OAuth login from `~/.claude` (no `ANTHROPIC_API_KEY` involved).

**Work queue.** The server long-polls `GET .../work/poll`. When a client (mobile app,
claude.ai/code) creates a session in the environment, a work item appears:

```
{"id":"cse_011Vf8...","type":"work","environment_id":"env_01...","state":"queued",
 "data":{"type":"session","id":"cse_011Vf8..."},"secret":"[REDACTED]",...}
```

The server `POST .../work/<id>/ack`s it and **spawns a child claude process**:

```
claude --print --sdk-url https://api.anthropic.com/v1/code/sessions/cse_011Vf8...
       --session-id cse_011Vf8... --input-format stream-json --output-format stream-json
       --replay-user-messages --permission-mode bypassPermissions
```

with a session access token (~5h expiry; the bridge schedules refresh with a 300s
buffer). The child connects to the cloud session over SSE
(`/v1/code/sessions/<id>/worker/events/stream` + POST `/worker/events`).

**The decisive finding:** a remote-control session is *not* a TUI. It is a headless
`--print --output-format stream-json` child attached to a cloud session. Everything it
emits is the **same stream-json contract `claude_local` already parses**, including:

- assistant/user/tool events with full content blocks;
- a terminal `result` event with `total_cost_usd`, `usage` (input/output/cache tokens),
  `modelUsage` per model with per-model `costUSD`, `num_turns`, durations;
- `rate_limit_event` frames: `{"rateLimitType":"five_hour","resetsAt":1781133000,
  "overageStatus":"rejected",...}` — direct, machine-readable proof these sessions draw
  from the **subscription 5-hour window**, plus the exact reset timestamp;
- `control_request {subtype:"end_session"}` when the client archives the session.

The bridge also writes a local transcript per session
(`%TEMP%/bridge-transcript-<cse-id>.jsonl`).

Billing classification therefore keys off the **session ingress** (`cc_entrypoint`,
the `/v1/code/sessions` attachment), not off a TTY. That means an adapter can get
subscription billing *and* structured, parseable output simultaneously — no terminal
scraping required.

**What the logs do not show:** the *client-side* API the mobile app uses to create a
session in an environment and send user messages (the logs only show the worker side
receiving the resulting work item). This is the one genuinely unknown API surface and
is Spike #1 below. It is capturable on this machine: Chip's API logging proxy
(`Projects/claude-proxy/proxy.js`, localhost:8787) or browser devtools against
https://claude.ai/code will show the exact requests.

---

## 3. Approaches evaluated

### (a) PTY-driven interactive TUI via ConPTY (node-pty)

Spawn the real `claude` TUI under a pseudo-terminal, write the prompt as keystrokes,
scrape the screen for results.

- **Pros:** No private APIs — uses exactly the surface a human uses; unambiguously the
  "terminal session" surface; works fully offline from Anthropic's RC infrastructure.
- **Cons (disqualifying):**
  - No structured output. Results, token usage, cost, and session ids must be scraped
    from ANSI-rendered TUI frames that redraw constantly (spinners, status line,
    thinking indicators). The `result` JSON (`total_cost_usd`, usage) is simply never
    rendered — usage capture would degrade to parsing the on-disk session `.jsonl` and
    `/usage` screens.
  - TUI layout churns every release (Claude Code ships weekly); every redesign breaks
    the scraper. This is the highest-maintenance option by far.
  - Driving multi-turn flows (trust dialog, permission prompts, AskUserQuestion modals)
    means keystroke injection against a screen-diffing state machine — the classic
    `expect` failure mode.
  - **Windows specifics:** ConPTY requires node-pty native builds (MSVC toolchain pinned
    to the server's Node ABI); ConPTY translates the buffer into VT sequences with its
    own repaint batching, so frame capture is non-deterministic; resize events and
    UTF-16 surrogate handling are recurring node-pty/ConPTY bug farms; the paperclip
    server would carry a native dependency for one adapter.
- **Billing/ToS:** Bills to subscription (it *is* the terminal surface), but this is
  also the most adversarial-looking shape — synthesizing keystrokes to impersonate a
  human at the exact surface whose billing distinction is "interactive". If Anthropic
  ever audits, "robot typing into the TUI" is harder to defend than "client of the
  documented remote-session product".
- **Verdict: reject.** All of the cost, none of the structure.

### (b) Remote-control bridge protocol — **recommended**

Drive sessions through the remote-control product the way the mobile app does. Two
sub-shapes:

- **(b1) Reimplement the worker side:** paperclip registers its own bridge environment
  (`POST /v1/environments/bridge`), polls the work queue, and spawns the
  `--sdk-url` children itself. Maximum control, but session *creation* is still
  client-side — you need both halves of the protocol, plus token plumbing
  (`environment_secret`, per-work `secret`, refresh).
- **(b2) Client-side adapter (recommended):** paperclip supervises a stock
  `claude remote-control` server per workspace directory (one already runs durably on
  this machine via Task Scheduler) and acts as a *client*: create a session in the
  environment, send the heartbeat prompt as a user message, read events/result. The rc
  server keeps owning spawn, auth, token refresh, capacity, and crash handling — all
  the code Anthropic maintains.

- **Pros:**
  - Subscription-billed by Anthropic's own classification (the `rate_limit_event:
    five_hour` frames are the receipt), and the reset timestamp feeds paperclip's
    `retryNotBefore` / `getQuotaWindows` directly.
  - Structured output identical to `claude_local` — `parseClaudeStreamJson()` and the
    whole error-detector family are reusable nearly verbatim.
  - Sessions are persistent and resumable server-side (`cse_*` ids), mapping cleanly
    onto `agent_task_sessions`.
  - `--permission-mode bypassPermissions` is the rc spawn default in our logs — the
    headless-autonomy assumption holds; no interactive prompts block runs.
  - Multi-session: `--capacity 32`, `--spawn worktree` for isolation; proven on
    Windows (running on STARFORGE for weeks).
- **Cons / risks:**
  - The client-side session API (`/v1/code/sessions`?) is **undocumented and private**;
    it can change without notice. Mitigation: thin client module, spike first,
    version-pin the rc server binary, fall back to `claude_local` on protocol errors.
  - Requires a running rc server per workspace dir (operational dependency).
    Mitigation: `testEnvironment` checks + reuse `local-service-supervisor`.
  - Observability is via cloud session events; if the SSE client stream proves awkward,
    the local `bridge-transcript-<id>.jsonl` is a fallback results channel.
- **Billing/ToS (honest):** This automates a surface Anthropic bills as interactive.
  It uses the real subscription OAuth, the official rc server, and the official client
  protocol — but paperclip is not the official client. Risk that Anthropic reclassifies
  programmatically-created rc sessions (they have the telemetry: `client_platform`,
  `cc_entrypoint`) or rate-limits unofficial clients. Assessment: **medium**, the
  lowest of the viable options; volume is one team's agent workload, not a resale
  operation, and the Max plan explicitly covers heavy personal/team use through its
  5h/7d windows. Accept and keep `claude_local` as a degradation path.

### (c) Claude Code "Channels" / MCP plugins as a control surface

Investigated against the installed binary (v2.1.172): **there is no `channels`
subcommand or channel plugin surface in this build** (`claude --help` lists agents,
auth, mcp, plugin, project, ...). What MCP actually offers is tools *inside* a session
— an MCP server cannot start a turn; something still has to send the user message.

The realizable version of this idea is a **"resident agent"**: keep one interactive
session alive (terminal or rc spawn, subscription-billed) running a `/loop`-style skill
that polls paperclip's API for work and posts results back via MCP/CLI.

- **Pros:** no private APIs at all; trivially subscription-billed; could ship today.
- **Cons:** inverts the control model — paperclip can't start/stop/time-box runs, no
  per-run `AdapterExecutionResult`, no per-run usage attribution (one ever-growing
  session, context compaction destroys auditability), failure recovery is "human
  restarts the loop", and a wedged loop silently stalls the whole agent. It bypasses
  heartbeat scheduling, budget enforcement, and session bookkeeping entirely.
- **Verdict: reject as the adapter**, but note it's a legitimate manual stopgap for
  June 15 while (b) is built.

### (d) What the codebase already has

- **acpx_local** (Agent Client Protocol runtime): closest architectural precedent for
  persistent sessions (warm handles, config fingerprinting, 15-min retention,
  session codec). **But it does not solve billing**: ACP bridges drive claude through
  the SDK/headless surface — exactly the post-June-15 credit-pool surface. Reuse its
  *patterns*, not its transport.
- **claude_local session persistence** (`--resume`, on-disk `.jsonl`, poisoned-session
  recovery): the recovery taxonomy and `sessionParams` shape carry over to the new
  adapter with `cse_*` ids substituted.
- **openclaw_gateway**: precedent for an adapter whose execution target is a network
  protocol (WebSocket + JSON-RPC, session-key strategies `fixed|issue|run`). Its
  session-scoping config is the right shape to copy.
- **`claude agents` subcommand** (background agents) exists in v2.1.172 — an adjacent
  Anthropic-cloud surface. Out of scope here (different execution environment; doesn't
  run against the local workspace), but worth a one-line check during the spike in case
  it exposes a *documented* session-creation API that rc sessions share.

---

## 4. Recommendation: `claude_remote` adapter (approach b2)

A new built-in adapter `packages/adapters/claude-remote`, type `claude_remote`, that is
a **client of the remote-control session protocol**, reusing `claude-local`'s parsing
and error taxonomy.

### Architecture

```
paperclip heartbeat run
  └─ claude_remote.execute(ctx)
       ├─ resolve bridge environment for workspace cwd        (bridge-pointer.json /
       │                                                       supervised rc server)
       ├─ resume cse session from runtime.sessionParams, else
       │    POST <session-create>  {environment_id, title, ...}      [client API]
       ├─ POST user message = rendered heartbeat prompt              [client API]
       ├─ stream session events (SSE) ──→ onLog (stream-json lines)
       │     • rate_limit_event → quota window bookkeeping
       │     • result event     → parseClaudeStreamJson()
       └─ return AdapterExecutionResult
            usage, costUsd (informational), billingType: "subscription",
            sessionParams { cseSessionId, environmentId, cwd, promptBundleKey },
            errorCode/retryNotBefore from the shared detectors
                  │
   claude remote-control (stock binary, supervised, spawn=same-dir, capacity N)
       └─ spawns `claude --print --sdk-url .../cse_* --output-format stream-json
                  --permission-mode bypassPermissions` per session
```

### Heartbeat → session mapping

- **One rc environment per workspace directory** (the rc server registers per-cwd; the
  decide-hub agents workspace gets its own server instance, `--spawn same-dir` v1,
  `worktree` later for parallel tasks).
- **One cse session per `(agentId, taskKey)`**, stored in `sessionParams` exactly like
  claude_local stores its session uuid. A heartbeat run = one user-message turn into
  that session, awaited until the `result` event. Resume = send the next message to the
  same cse id. Fresh session when: no session, cwd changed, prompt bundle changed,
  unknown-session/archived error (→ `clearSession: true`), or session poisoned.
- **Turn boundary = `result` event.** `timeoutSec`/`graceSec` apply to the await; on
  timeout, send `control_request end_session` (or `work/<id>/stop` equivalent via
  client API) and report `timedOut: true`.

### Usage, cost, and budget integration

- `usage` and `costUsd` come from the `result` event (same fields as today).
  `billingType: "subscription"` — `normalizeBilledCostCents` already treats
  subscription cost as informational rather than billable spend.
- New: persist the latest `rate_limit_event` (`rateLimitType`, `resetsAt`,
  `overageStatus`) per agent; surface it via `getQuotaWindows` (claude_local already
  has the hook) and map window-exhausted errors to
  `errorFamily: "transient_upstream"` + `retryNotBefore = resetsAt` so the heartbeat
  scheduler backs off to the window reset instead of hammering.
- Tag agents using this adapter with `metadata.billing = anthropic-subscription` so the
  existing pacer tooling pauses/resumes them with the rest of the subscription fleet.

### Skills & instructions

The rc server spawns children with fixed args — the adapter cannot inject `--add-dir`
per session (v1). Consequences, documented as a known limitation:

- Agent instructions ride in the rendered prompt (claude_local already inlines
  instructions+wake payload via stdin; same approach, via user message).
- Skills resolve from the workspace's own `.claude/skills` and user-level skills in the
  rc server's HOME. v1: sync paperclip skills into the workspace `.claude/skills`
  (the existing `syncSkills` hook fits); the prompt-bundle `--add-dir` mechanism is N/A.
- `promptBundleKey` still participates in resume invalidation so instruction changes
  rotate sessions, same as claude_local.

### Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| rc server not running / bridge env stale | `testEnvironment`: bridge-pointer.json present, poll loop alive (process check), hello session | start via supervisor / surface `error` check; runs fail fast with actionable message |
| Session-create API drift (private API changed) | non-2xx / schema mismatch on client calls | `errorCode: claude_remote_protocol`, run fails, agent can be flipped to `claude_local` (config-only change) |
| Access-token expiry mid-turn | SSE drop + 401 | rc server owns refresh for workers; client re-auths from `~/.claude` OAuth (same refresh path as `setup-token`) |
| 5h/weekly window exhausted | `rate_limit_event` `status!=allowed` / limit-pattern in result | `transient_upstream` + `retryNotBefore=resetsAt` |
| Session archived/ended server-side | unknown-session error on message send | `clearSession: true`, retry fresh next run (claude_local pattern) |
| Child crash on worker side | work item `state=failed`, no result event before timeout | timeout path; `clearSession`; transcript jsonl post-mortem |
| Capacity exhausted (32 concurrent) | session-create rejected | treat as transient; serialize via per-environment semaphore in adapter |
| Windows sleep/network blip | SSE disconnect | reconnect-with-replay (events have seq numbers per the SSE transport logs); else re-poll result from transcript |

### Spike checklist (verify before building — ~half day)

1. **Capture the client session API**: create a session from claude.ai/code (or mobile
   app) against the existing STARFORGE rc environment with Chip's logging proxy /
   devtools recording. Confirm: create-session endpoint+payload, message-send
   endpoint, client event-stream endpoint, auth header shape (OAuth bearer from
   `~/.claude`; check `claude setup-token` output works for this).
2. **Replay with curl**: create a session + send "hello" purely via captured API; watch
   the rc server log spawn the child and the `result` event land in
   `bridge-transcript-*.jsonl`. This proves no official client is required.
3. **Confirm billing signals**: `rate_limit_event: five_hour` present on these turns;
   after June 15, verify on the usage dashboard that they draw from the subscription
   window, not the credit pool. **This is the go/no-go gate.**
4. **Multi-turn resume**: send a second message to the same cse session; confirm
   context carries and a second `result` event arrives.
5. **Concurrency**: two sessions in one environment; confirm both spawn.
6. **Quick check**: does `claude agents` expose any *documented* equivalent (it would
   lower API-drift risk if so).

### Build plan (~2 agent-days after spike)

**Day 1 — adapter core**
- Scaffold `packages/adapters/claude-remote` (copy claude-local layout; shared metadata,
  `agentConfigurationDoc` explaining when to use vs `claude_local`).
- Client module: bridge-pointer/env resolution, session create, message send, SSE event
  stream with seq-replay reconnect (pattern from openclaw-gateway's frame handling).
- `execute()`: session resume/rotate logic (port claude_local's `canResumeSession`
  checks, substituting cse ids), prompt rendering (reuse claude_local's prompt
  assembly), event pump → `onLog`, result parsing via shared `parseClaudeStreamJson`
  (lift it into `adapter-utils` or import from claude-local).
- Result mapping: usage/cost/billingType/sessionParams/sessionDisplayId (`cse_*`),
  error detectors reused; new `rate_limit_event` → `retryNotBefore`.

**Day 2 — lifecycle, environment, registration**
- `testEnvironment`: rc server liveness (pointer file + poll-loop heartbeat or process
  match on CommandLine `remote-control` — never by process name), OAuth subscription
  login check (no `ANTHROPIC_API_KEY` override), optional live hello-session probe.
- rc server supervision: v1 assume externally-managed (Task Scheduler, as today) with a
  clear `testEnvironment` error when absent; stretch: register with
  `local-service-supervisor` for auto-start.
- Session teardown: `end_session` on `clearSession`/timeout; per-environment
  concurrency semaphore.
- Register in the three registries (`server/src/adapters/registry.ts`,
  `ui/src/adapters/registry.ts`, `cli/src/adapters/registry.ts`); UI stdout parser and
  CLI formatter are claude-local's (same stream-json).
- `sessionCodec` (cse id display), `getQuotaWindows` from persisted rate-limit state.
- Docs page `docs/adapters/claude-remote.md` + config reference; unit tests for the
  client module against captured fixtures.

**Out of scope (follow-ups):** worktree spawn mode, multi-machine environments,
auto-provisioning rc servers per project, replacing the polling stopgap if Anthropic
ships a documented sessions API.

---

## 5. Decision summary

| Approach | Structured output | Billing | API risk | Maintenance | Verdict |
|---|---|---|---|---|---|
| (a) ConPTY TUI scripting | none (scraping) | subscription | none (no API) | extreme (TUI churn, node-pty) | reject |
| (b) remote-control client | full stream-json | subscription (evidenced by `five_hour` rate-limit frames) | medium (private API) | low (reuses claude-local parsing) | **recommend** |
| (c) Channels MCP / resident agent | n/a (no such surface in v2.1.172) | subscription | n/a | n/a as adapter | reject (manual stopgap only) |
| (d) acpx | full | **credit pool** (SDK surface) | low | low | doesn't solve the problem |

Recommended: **(b2) `claude_remote`**, gated on Spike #3 (billing verification) before
any build effort beyond the spike.
