import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, asBoolean, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { readClaudeToken } from "@paperclipai/adapter-claude-local/server";
import {
  ClaudeRemoteSessionsClient,
  ClaudeRemoteProtocolError,
  CLAUDE_REMOTE_DEFAULT_BASE_URL,
} from "./client.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.baseUrl, CLAUDE_REMOTE_DEFAULT_BASE_URL);
  const liveProbe = asBoolean(config.liveProbe, false);

  if (ctx.executionTarget && ctx.executionTarget.kind === "remote") {
    checks.push({
      code: "claude_remote_unsupported_target",
      level: "error",
      message: "claude_remote is local-only (v1); it cannot run against a remote execution target.",
      hint: "Use claude_local for remote/sandbox targets.",
    });
    return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
  }

  const cwd = asString(config.cwd, "") || process.cwd();
  if (path.isAbsolute(cwd)) {
    checks.push({ code: "claude_remote_cwd", level: "info", message: `Working directory: ${cwd}` });
  } else {
    checks.push({
      code: "claude_remote_cwd_relative",
      level: "warn",
      message: `Working directory is not absolute: ${cwd}`,
      hint: "Set an absolute cwd in the adapter config.",
    });
  }

  // Subscription OAuth only — a raw API key cannot drive cloud sessions.
  if (isNonEmpty(config.env && (config.env as Record<string, unknown>).ANTHROPIC_API_KEY) || isNonEmpty(process.env.ANTHROPIC_API_KEY)) {
    checks.push({
      code: "claude_remote_api_key_present",
      level: "info",
      message: "ANTHROPIC_API_KEY is set but will be stripped from the worker child; cloud sessions use subscription OAuth.",
    });
  }

  const oauthToken = await readClaudeToken();
  if (!oauthToken) {
    checks.push({
      code: "claude_remote_oauth_missing",
      level: "error",
      message: "No claude.ai subscription OAuth token found (~/.claude/.credentials.json).",
      hint: "Run `claude login` to sign in with the claude.ai subscription account.",
    });
    return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
  }
  checks.push({
    code: "claude_remote_oauth_present",
    level: "info",
    message: "claude.ai subscription OAuth token found for cloud-session auth.",
  });

  if (liveProbe) {
    const client = new ClaudeRemoteSessionsClient({ oauthToken, baseUrl });
    try {
      const session = await client.createSession({ title: "paperclip env probe", cwd });
      await client.claimWorker(session.id);
      await client.archiveSession(session.id).catch(() => {});
      checks.push({
        code: "claude_remote_live_probe_passed",
        level: "info",
        message: "Created and worker-claimed a live cloud session (no worker spawned).",
        detail: session.id,
      });
    } catch (err) {
      const message = err instanceof ClaudeRemoteProtocolError ? err.message : err instanceof Error ? err.message : String(err);
      checks.push({
        code: "claude_remote_live_probe_failed",
        level: "error",
        message: "Live cloud-session probe failed.",
        detail: message,
        hint: "The captured session protocol may have drifted, or the OAuth token is invalid/expired. Escalate to Foreman if the API has changed.",
      });
    }
  }

  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
