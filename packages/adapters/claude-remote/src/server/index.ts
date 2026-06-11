import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getQuotaWindows } from "./rate-limit-state.js";
export {
  ClaudeRemoteSessionsClient,
  ClaudeRemoteProtocolError,
  SseParser,
  normalizeSessionEvent,
  redactSecrets,
  CLAUDE_REMOTE_DEFAULT_BASE_URL,
} from "./client.js";
export { ClaudeRemoteWorkerChild, buildWorkerSpawnSpec } from "./worker.js";
export {
  parseRateLimitEvent,
  rateLimitResetDate,
  isRateLimitExhausted,
} from "./rate-limit-state.js";

// claude_remote reuses claude_local's skill model: skills resolve from the
// workspace + user-level skills home; the worker child gets fixed args.
export { listClaudeSkills as listSkills, syncClaudeSkills as syncSkills } from "@paperclipai/adapter-claude-local/server";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const cseSessionId =
      readNonEmptyString(record.cseSessionId) ??
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!cseSessionId) return null;
    const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir);
    const promptBundleKey =
      readNonEmptyString(record.promptBundleKey) ?? readNonEmptyString(record.prompt_bundle_key);
    return {
      cseSessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const cseSessionId =
      readNonEmptyString(params.cseSessionId) ??
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!cseSessionId) return null;
    const cwd = readNonEmptyString(params.cwd) ?? readNonEmptyString(params.workdir);
    const promptBundleKey =
      readNonEmptyString(params.promptBundleKey) ?? readNonEmptyString(params.prompt_bundle_key);
    return {
      cseSessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.cseSessionId) ?? readNonEmptyString(params.sessionId);
  },
};
