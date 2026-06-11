import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  joinPromptSections,
  readPaperclipRuntimeSkillEntries,
  renderPaperclipWakePrompt,
  renderTemplate,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeTransientUpstreamError,
  isClaudeUnknownSessionError,
  prepareClaudePromptBundle,
  resolveClaudeDesiredSkillNames,
  readClaudeToken,
} from "@paperclipai/adapter-claude-local/server";
import {
  ClaudeRemoteSessionsClient,
  ClaudeRemoteProtocolError,
  CLAUDE_REMOTE_DEFAULT_BASE_URL,
  isUnknownSessionStatus,
} from "./client.js";
import { ClaudeRemoteWorkerChild, buildWorkerSpawnSpec } from "./worker.js";
import {
  parseRateLimitEvent,
  recordRateLimitObservation,
  rateLimitResetDate,
  isRateLimitExhausted,
  type ClaudeRemoteRateLimitInfo,
} from "./rate-limit-state.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

interface ResolvedSession {
  cseSessionId: string;
  resumed: boolean;
}

interface TurnOutcome {
  resultEvent: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  workerExitCode: number | null;
  workerSignal: string | null;
  rateLimit: ClaudeRemoteRateLimitInfo | null;
  unknownSession: boolean;
}

function isCseId(value: string): boolean {
  return value.startsWith("cse_") && value.length > "cse_".length;
}

/**
 * Drive one user-message turn against a cloud session through a supervised
 * worker child.
 *
 * The worker (CCR-v2) is a headless compute attachment: it does NOT print the
 * turn's stream-json to its own stdout; it POSTs assistant/result/rate_limit
 * events back to the cloud session. The adapter therefore reads the turn from
 * the *client* events stream (GET /v1/code/sessions/{id}/events/stream) — those
 * payloads ARE the stream-json events claude_local already parses, so we
 * reconstruct a stream-json transcript from them and reuse parseClaudeStreamJson.
 *
 * Resolves on the terminal `result` event, the worker exiting, or the timeout.
 */
async function runTurn(input: {
  client: ClaudeRemoteSessionsClient;
  cseSessionId: string;
  workerJwt: string;
  workerEpoch: string | null;
  prompt: string;
  command: string;
  baseUrl: string;
  cwd: string;
  childEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: AdapterExecutionContext["onLog"];
  onSpawn?: AdapterExecutionContext["onSpawn"];
}): Promise<TurnOutcome> {
  let rateLimit: ClaudeRemoteRateLimitInfo | null = null;
  const streamLines: string[] = [];
  let resolveResult: ((value: Record<string, unknown> | null) => void) | null = null;
  const resultPromise = new Promise<Record<string, unknown> | null>((resolve) => {
    resolveResult = resolve;
  });

  const worker = new ClaudeRemoteWorkerChild(
    buildWorkerSpawnSpec({
      sessionId: input.cseSessionId,
      workerJwt: input.workerJwt,
      workerEpoch: input.workerEpoch,
      cwd: input.cwd,
      command: input.command,
      baseUrl: input.baseUrl,
      env: input.childEnv,
    }),
    {
      // Worker stdout/stderr are startup/diagnostic only — forward stderr so
      // failures are visible, but the turn's events come from the client stream.
      onLog: async (stream, chunk) => {
        if (stream === "stderr") await input.onLog("stderr", chunk);
      },
      onSpawn: input.onSpawn,
    },
  );

  worker.spawn();

  // Post the user message into the cloud session; the worker picks it up over
  // its worker event stream. --replay-user-messages covers the connect race.
  let unknownSession = false;
  try {
    await input.client.sendUserMessage(input.cseSessionId, input.prompt);
  } catch (err) {
    if (err instanceof ClaudeRemoteProtocolError && isUnknownSessionStatus(err.status)) {
      unknownSession = true;
    } else {
      await worker.stop(input.graceSec * 1000);
      throw err;
    }
  }

  const streamController = new AbortController();
  let timedOut = false;

  if (!unknownSession) {
    const streamPromise = input.client
      .streamEvents(input.cseSessionId, {
        signal: streamController.signal,
        onEvent: async (event) => {
          const payload = event.payload;
          if (!payload) return;
          const type = typeof payload.type === "string" ? payload.type : "";
          const line = JSON.stringify(payload);
          streamLines.push(line);
          // Feed the UI/CLI parser the exact stream-json claude_local emits.
          await input.onLog("stdout", `${line}\n`);
          if (type === "rate_limit_event") {
            const info = parseRateLimitEvent(payload);
            if (info) {
              rateLimit = info;
              recordRateLimitObservation(info, input.cseSessionId);
            }
          } else if (type === "result") {
            resolveResult?.(payload);
            streamController.abort();
          }
        },
        onLog: (message) => input.onLog("stderr", `${message}\n`),
      })
      .catch(() => {
        // stream end/abort is expected on result or teardown
      });

    const waiters: Array<Promise<"result" | "exit" | "timeout">> = [
      resultPromise.then(() => "result" as const),
      worker.waitForExit().then(() => "exit" as const),
    ];
    let timer: NodeJS.Timeout | null = null;
    if (input.timeoutSec > 0) {
      waiters.push(
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), input.timeoutSec * 1000);
        }),
      );
    }
    const outcome = await Promise.race(waiters);
    if (timer) clearTimeout(timer);
    timedOut = outcome === "timeout";
    streamController.abort();
    await streamPromise;
  }

  await worker.stop(input.graceSec * 1000);
  const exit = worker.exited ?? { exitCode: null, signal: null };

  // Reconstruct a stream-json transcript from the client events and reuse the
  // claude_local parser verbatim (the payloads are identical stream-json).
  const transcript = streamLines.join("\n");
  const parsedStream = parseClaudeStreamJson(transcript);

  return {
    resultEvent: parsedStream.resultJson,
    stdout: transcript,
    stderr: worker.stderr,
    timedOut,
    workerExitCode: exit.exitCode,
    workerSignal: exit.signal,
    rateLimit,
    unknownSession,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn } = ctx;

  if (ctx.executionTarget && ctx.executionTarget.kind === "remote") {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage:
        "claude_remote does not support remote execution targets (v1 is local-only). Use claude_local for remote targets.",
      errorCode: "claude_remote_unsupported_target",
    };
  }

  const oauthToken = await readClaudeToken();
  if (!oauthToken) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage:
        "No claude.ai subscription OAuth token found (~/.claude/.credentials.json). Run `claude login`; cloud sessions reject API keys.",
      errorCode: "claude_auth_required",
    };
  }

  const command = asString(config.command, "claude");
  const baseUrl = asString(config.baseUrl, CLAUDE_REMOTE_DEFAULT_BASE_URL);
  const clientPlatform = asString(config.clientPlatform, "claude_code_remote");
  const model = asString(config.model, "");
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Child env: paperclip env + configured env, minus the API-key keys (cloud
  // sessions are subscription-OAuth only).
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !FORBIDDEN_ENV_KEYS.has(key)) childEnv[key] = value;
  }
  Object.assign(childEnv, buildPaperclipEnv(agent));
  childEnv.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    "";
  if (wakeTaskId) childEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) childEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) childEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  const configEnv = parseObject(config.env);
  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string" && !FORBIDDEN_ENV_KEYS.has(key)) childEnv[key] = value;
  }

  // Instructions inlined into the first user message of a fresh session (the
  // worker child is spawned with fixed args, so --add-dir/--append-system-prompt
  // are unavailable here — design §4 "Skills & instructions").
  let combinedInstructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const content = await fs.readFile(instructionsFilePath, "utf-8");
      const dir = `${path.dirname(instructionsFilePath)}/`;
      combinedInstructionsContents =
        content +
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${dir}.`;
    } catch (err) {
      await onLog(
        "stderr",
        `[claude-remote] Warning: could not read instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveClaudeDesiredSkillNames(config, skillEntries));
  const promptBundle = await prepareClaudePromptBundle({
    companyId: agent.companyId,
    skills: skillEntries.filter((entry) => desiredSkillNames.has(entry.key)),
    instructionsContents: combinedInstructionsContents,
    onLog,
  });

  // Resume / rotate decision (ports claude_local canResumeSession onto cse ids).
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const storedSessionId = asString(runtimeSessionParams.cseSessionId, asString(runtimeSessionParams.sessionId, runtime.sessionId ?? ""));
  const storedCwd = asString(runtimeSessionParams.cwd, "");
  const storedPromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const cwdMatches = storedCwd.length === 0 || path.resolve(storedCwd) === path.resolve(cwd);
  const bundleMatches = storedPromptBundleKey.length === 0 || storedPromptBundleKey === promptBundle.bundleKey;
  const canResume = storedSessionId.length > 0 && isCseId(storedSessionId) && cwdMatches && bundleMatches;
  if (storedSessionId && !canResume) {
    const reason = !isCseId(storedSessionId)
      ? `is not a cse_* id`
      : !cwdMatches
      ? `was saved for cwd "${storedCwd}"`
      : `was saved for prompt bundle "${storedPromptBundleKey}"`;
    await onLog("stdout", `[claude-remote] Stored session "${storedSessionId}" ${reason}; starting a fresh session.\n`);
  }

  const client = new ClaudeRemoteSessionsClient({ oauthToken, baseUrl, clientPlatform });

  // Prompt: resumed sessions get the wake delta; fresh sessions get the full
  // rendered prompt (with instructions inlined first).
  const resumed = canResume;
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !resumed && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: resumed });
  const useResumeDelta = resumed && wakePrompt.length > 0;
  const renderedPrompt = useResumeDelta ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const prompt = joinPromptSections([
    resumed ? "" : combinedInstructionsContents ?? "",
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);

  const resolveSession = async (forceFresh: boolean): Promise<ResolvedSession> => {
    if (!forceFresh && canResume) {
      return { cseSessionId: storedSessionId, resumed: true };
    }
    const created = await client.createSession({
      title: wakeTaskId ? `paperclip ${wakeTaskId}` : `paperclip ${agent.name}`,
      cwd,
      model: model || null,
    });
    return { cseSessionId: created.id, resumed: false };
  };

  const attempt = async (forceFresh: boolean): Promise<{ outcome: TurnOutcome; session: ResolvedSession }> => {
    const session = await resolveSession(forceFresh);
    const claim = await client.claimWorker(session.cseSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_remote",
        command,
        cwd,
        commandArgs: ["--sdk-url", `${baseUrl}/v1/code/sessions/${session.cseSessionId}`],
        commandNotes: [
          session.resumed
            ? `Resuming cloud session ${session.cseSessionId}.`
            : `Created cloud session ${session.cseSessionId}.`,
          "Worker child driven via subscription OAuth (no API key).",
        ],
        prompt,
        context,
      });
    }
    const outcome = await runTurn({
      client,
      cseSessionId: session.cseSessionId,
      workerJwt: claim.workerJwt,
      workerEpoch: claim.workerEpoch,
      prompt,
      command,
      baseUrl: claim.apiBaseUrl ?? baseUrl,
      cwd,
      childEnv,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
    });
    return { outcome, session };
  };

  const toResult = (
    outcome: TurnOutcome,
    session: ResolvedSession,
    opts: { clearOnUnknown: boolean },
  ): AdapterExecutionResult => {
    const sessionParams = {
      cseSessionId: session.cseSessionId,
      cwd,
      promptBundleKey: promptBundle.bundleKey,
    };

    if (outcome.unknownSession) {
      return {
        exitCode: outcome.workerExitCode,
        signal: outcome.workerSignal,
        timedOut: false,
        errorMessage: `Cloud session ${session.cseSessionId} is unknown or archived server-side.`,
        errorCode: "claude_remote_unknown_session",
        clearSession: opts.clearOnUnknown,
      };
    }

    if (outcome.timedOut) {
      return {
        exitCode: outcome.workerExitCode,
        signal: outcome.workerSignal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s waiting for the result event.`,
        errorCode: "timeout",
        sessionParams,
        sessionDisplayId: session.cseSessionId,
        billingType: "subscription",
        clearSession: false,
      };
    }

    const parsed = outcome.resultEvent;
    const parsedStream = parseClaudeStreamJson(outcome.stdout);

    // rate_limit_event → retryNotBefore when the window is exhausted.
    const exhausted = outcome.rateLimit ? isRateLimitExhausted(outcome.rateLimit) : false;
    const rateLimitReset = outcome.rateLimit ? rateLimitResetDate(outcome.rateLimit) : null;

    if (!parsed) {
      // No result event: worker died mid-turn before completing the turn. The
      // cloud session is intact server-side, so do NOT clear it; treat as a
      // transient upstream failure so the scheduler retries.
      const stderrLine =
        outcome.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
      const transient = exhausted || isClaudeTransientUpstreamError({ stdout: outcome.stdout, stderr: outcome.stderr });
      return {
        exitCode: outcome.workerExitCode,
        signal: outcome.workerSignal,
        timedOut: false,
        errorMessage:
          stderrLine
            ? `Worker exited without a result event: ${stderrLine}`
            : `Worker exited (code ${outcome.workerExitCode ?? -1}) without a result event.`,
        errorCode: transient ? "claude_transient_upstream" : "claude_remote_no_result",
        errorFamily: transient ? "transient_upstream" : null,
        retryNotBefore: exhausted && rateLimitReset ? rateLimitReset.toISOString() : null,
        sessionParams,
        sessionDisplayId: session.cseSessionId,
        billingType: "subscription",
        resultJson: { stdout: outcome.stdout, stderr: outcome.stderr },
        clearSession: false,
      };
    }

    const loginMeta = detectClaudeLoginRequired({ parsed, stdout: outcome.stdout, stderr: outcome.stderr });
    const maxTurns = isClaudeMaxTurnsResult(parsed);
    const isError = parsed.is_error === true;
    const failed = isError || (outcome.workerExitCode ?? 0) !== 0;
    const transient =
      failed && !loginMeta.requiresLogin && !maxTurns &&
      (exhausted || isClaudeTransientUpstreamError({ parsed, stdout: outcome.stdout, stderr: outcome.stderr }));

    const errorCode = loginMeta.requiresLogin
      ? "claude_auth_required"
      : maxTurns
      ? "max_turns_exhausted"
      : transient
      ? "claude_transient_upstream"
      : null;

    return {
      exitCode: outcome.workerExitCode,
      signal: outcome.workerSignal,
      timedOut: false,
      errorMessage: failed ? describeClaudeFailure(parsed) ?? `Worker turn failed (code ${outcome.workerExitCode ?? -1}).` : null,
      errorCode,
      errorFamily: transient ? "transient_upstream" : null,
      retryNotBefore: exhausted && rateLimitReset ? rateLimitReset.toISOString() : null,
      usage: parsedStream.usage ?? undefined,
      sessionId: session.cseSessionId,
      sessionParams,
      sessionDisplayId: session.cseSessionId,
      provider: "anthropic",
      biller: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType: "subscription",
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: maxTurns,
    };
  };

  try {
    const first = await attempt(false);
    if (first.outcome.unknownSession && first.session.resumed) {
      await onLog("stdout", `[claude-remote] Resume session unavailable; retrying with a fresh session.\n`);
      const retry = await attempt(true);
      return toResult(retry.outcome, retry.session, { clearOnUnknown: true });
    }
    // A result that reports an unknown-session error string → clear + retry fresh once.
    if (
      first.session.resumed &&
      first.outcome.resultEvent &&
      isClaudeUnknownSessionError(first.outcome.resultEvent)
    ) {
      await onLog("stdout", `[claude-remote] Resume session reported unavailable; retrying with a fresh session.\n`);
      const retry = await attempt(true);
      return toResult(retry.outcome, retry.session, { clearOnUnknown: true });
    }
    return toResult(first.outcome, first.session, { clearOnUnknown: first.session.resumed });
  } catch (err) {
    if (err instanceof ClaudeRemoteProtocolError) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: err.message,
        errorCode: "claude_remote_protocol",
        errorFamily: err.status === 429 || (err.status != null && err.status >= 500) ? "transient_upstream" : null,
      };
    }
    throw err;
  }
}
