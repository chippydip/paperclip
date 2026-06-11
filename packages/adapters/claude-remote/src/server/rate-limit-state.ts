/**
 * Quota bookkeeping for rate_limit_event frames emitted by the worker child.
 *
 * Captured frame shape (bridge transcripts, GOLA-5):
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
 *    "resetsAt":1781151000,"rateLimitType":"five_hour","overageStatus":"rejected",
 *    "overageDisabledReason":"out_of_credits","isUsingOverage":false}, ...}
 *
 * These frames are direct evidence the turn drew from the subscription window
 * and carry the exact reset timestamp, so they feed both retryNotBefore on
 * window exhaustion and the adapter's getQuotaWindows() surface.
 */
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import {
  getQuotaWindows as getClaudeLocalQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";

export interface ClaudeRemoteRateLimitInfo {
  status: string | null;
  rateLimitType: string | null;
  /** Unix epoch seconds when the window resets. */
  resetsAt: number | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
}

export interface ClaudeRemoteRateLimitObservation {
  info: ClaudeRemoteRateLimitInfo;
  sessionId: string | null;
  observedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse one stream-json event object; returns rate-limit info when the event is a rate_limit_event. */
export function parseRateLimitEvent(event: Record<string, unknown>): ClaudeRemoteRateLimitInfo | null {
  if (readString(event.type) !== "rate_limit_event") return null;
  const info = asRecord(event.rate_limit_info) ?? asRecord(event.rateLimitInfo) ?? {};
  return {
    status: readString(info.status),
    rateLimitType: readString(info.rateLimitType) ?? readString(info.rate_limit_type),
    resetsAt:
      typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
        ? info.resetsAt
        : typeof info.resets_at === "number" && Number.isFinite(info.resets_at)
        ? info.resets_at
        : null,
    overageStatus: readString(info.overageStatus),
    overageDisabledReason: readString(info.overageDisabledReason),
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
  };
}

export function rateLimitResetDate(info: ClaudeRemoteRateLimitInfo): Date | null {
  if (info.resetsAt == null) return null;
  const date = new Date(info.resetsAt * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when the frame reports the window exhausted (status anything but "allowed"). */
export function isRateLimitExhausted(info: ClaudeRemoteRateLimitInfo): boolean {
  return info.status !== null && info.status !== "allowed" && info.status !== "allowed_warning";
}

let lastObservation: ClaudeRemoteRateLimitObservation | null = null;

export function recordRateLimitObservation(info: ClaudeRemoteRateLimitInfo, sessionId: string | null): void {
  lastObservation = { info, sessionId, observedAt: new Date().toISOString() };
}

export function getLastRateLimitObservation(): ClaudeRemoteRateLimitObservation | null {
  return lastObservation;
}

export function resetRateLimitStateForTests(): void {
  lastObservation = null;
}

function describeObservationWindow(observation: ClaudeRemoteRateLimitObservation): QuotaWindow {
  const reset = rateLimitResetDate(observation.info);
  return {
    label: `Session window (${observation.info.rateLimitType ?? "unknown"}, last rc frame)`,
    usedPercent: null,
    resetsAt: reset ? reset.toISOString() : null,
    valueLabel: observation.info.status,
    detail: `Last rate_limit_event observed ${observation.observedAt}${observation.info.overageStatus ? `; overage ${observation.info.overageStatus}` : ""}`,
  };
}

/**
 * Quota surface: the claude-local OAuth usage windows (same subscription
 * account) plus the most recent rate_limit_event frame seen by this adapter.
 */
export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  const base = await getClaudeLocalQuotaWindows();
  if (!lastObservation) return base;
  return {
    ...base,
    windows: [...base.windows, describeObservationWindow(lastObservation)],
  };
}
