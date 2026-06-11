import { describe, it, expect, afterEach } from "vitest";
import {
  parseRateLimitEvent,
  rateLimitResetDate,
  isRateLimitExhausted,
  recordRateLimitObservation,
  getLastRateLimitObservation,
  resetRateLimitStateForTests,
} from "./rate-limit-state.js";

// Captured frame shape (redacted) from a bridge transcript, GOLA-5.
const CAPTURED_FRAME = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1781151000,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
  },
  uuid: "1f68da9a-b367-4387-83dc-3192a8f686c5",
  session_id: "00000000-0000-0000-0000-000000000000",
};

afterEach(() => resetRateLimitStateForTests());

describe("parseRateLimitEvent", () => {
  it("parses the captured five_hour frame", () => {
    const info = parseRateLimitEvent(CAPTURED_FRAME);
    expect(info).not.toBeNull();
    expect(info!.rateLimitType).toBe("five_hour");
    expect(info!.status).toBe("allowed");
    expect(info!.resetsAt).toBe(1781151000);
    expect(info!.overageStatus).toBe("rejected");
  });

  it("returns null for non rate_limit_event frames", () => {
    expect(parseRateLimitEvent({ type: "result" })).toBeNull();
    expect(parseRateLimitEvent({ type: "assistant", message: {} })).toBeNull();
  });

  it("maps the unix reset to a Date", () => {
    const info = parseRateLimitEvent(CAPTURED_FRAME)!;
    const date = rateLimitResetDate(info);
    expect(date).toBeInstanceOf(Date);
    expect(date!.getTime()).toBe(1781151000 * 1000);
  });
});

describe("isRateLimitExhausted", () => {
  it("treats allowed/allowed_warning as not exhausted", () => {
    expect(isRateLimitExhausted(parseRateLimitEvent(CAPTURED_FRAME)!)).toBe(false);
    expect(isRateLimitExhausted({ ...parseRateLimitEvent(CAPTURED_FRAME)!, status: "allowed_warning" })).toBe(false);
  });

  it("treats a non-allowed status as exhausted", () => {
    expect(isRateLimitExhausted({ ...parseRateLimitEvent(CAPTURED_FRAME)!, status: "rejected" })).toBe(true);
    expect(isRateLimitExhausted({ ...parseRateLimitEvent(CAPTURED_FRAME)!, status: "blocked" })).toBe(true);
  });
});

describe("observation bookkeeping", () => {
  it("records the latest observation", () => {
    const info = parseRateLimitEvent(CAPTURED_FRAME)!;
    recordRateLimitObservation(info, "cse_01ABC");
    const last = getLastRateLimitObservation();
    expect(last?.sessionId).toBe("cse_01ABC");
    expect(last?.info.rateLimitType).toBe("five_hour");
  });
});
