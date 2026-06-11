import { describe, it, expect } from "vitest";
import { buildWorkerSpawnSpec } from "./worker.js";

describe("buildWorkerSpawnSpec", () => {
  it("builds the captured rc worker child invocation", () => {
    const spec = buildWorkerSpawnSpec({
      sessionId: "cse_01ABC",
      workerJwt: "eyJfake.worker.jwt",
      cwd: "/work",
      baseUrl: "https://api.anthropic.com",
    });
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual([
      "--print",
      "--sdk-url",
      "https://api.anthropic.com/v1/code/sessions/cse_01ABC",
      "--session-id",
      "cse_01ABC",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(spec.cwd).toBe("/work");
  });

  it("injects the worker token via env and enables POST ingress v2", () => {
    const spec = buildWorkerSpawnSpec({
      sessionId: "cse_01ABC",
      workerJwt: "eyJfake.worker.jwt",
      cwd: "/work",
    });
    expect(spec.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN).toBe("eyJfake.worker.jwt");
    expect(spec.env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2).toBe("1");
  });

  it("sets the worker epoch and CCR-v2 env when an epoch is provided", () => {
    const spec = buildWorkerSpawnSpec({
      sessionId: "cse_01ABC",
      workerJwt: "jwt",
      workerEpoch: "1",
      cwd: "/work",
    });
    expect(spec.env.CLAUDE_CODE_WORKER_EPOCH).toBe("1");
    expect(spec.env.CLAUDE_CODE_USE_CCR_V2).toBe("1");
  });

  it("omits epoch env when no epoch is provided", () => {
    const spec = buildWorkerSpawnSpec({ sessionId: "cse_01ABC", workerJwt: "jwt", cwd: "/work" });
    expect(spec.env.CLAUDE_CODE_WORKER_EPOCH).toBeUndefined();
    expect(spec.env.CLAUDE_CODE_USE_CCR_V2).toBeUndefined();
  });

  it("strips API-key env so cloud sessions stay subscription-OAuth only", () => {
    const spec = buildWorkerSpawnSpec({
      sessionId: "cse_01ABC",
      workerJwt: "jwt",
      cwd: "/work",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
        ANTHROPIC_AUTH_TOKEN: "should-not-pass",
        PATH: "/usr/bin",
        UNDEFINED_VALUE: undefined,
      },
    });
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(spec.env.PATH).toBe("/usr/bin");
    expect(spec.env.UNDEFINED_VALUE).toBeUndefined();
  });

  it("normalizes a trailing slash on the base url", () => {
    const spec = buildWorkerSpawnSpec({
      sessionId: "cse_X",
      workerJwt: "jwt",
      cwd: "/work",
      baseUrl: "https://api.anthropic.com/",
    });
    expect(spec.args[2]).toBe("https://api.anthropic.com/v1/code/sessions/cse_X");
  });
});
