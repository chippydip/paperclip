/**
 * b1 self-worker supervisor: the adapter owns its own worker child instead of
 * relying on the stock remote-control server's dispatch (whose
 * environment-binding is server-side and uncaptured — see design §6
 * "residual unknown").
 *
 * The worker child is the exact captured rc spawn shape:
 *   claude --print --sdk-url {BASE}/v1/code/sessions/{id} --session-id {id}
 *          --input-format stream-json --output-format stream-json
 *          --replay-user-messages --permission-mode bypassPermissions
 * with env CLAUDE_CODE_SESSION_ACCESS_TOKEN={worker_jwt} and
 * CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1.
 *
 * The known pitfall (why the GOLA-5 spike could not close the loop): a bare
 * --print child exits on stdin EOF *before* the cloud message is delivered.
 * The supervisor therefore holds the child's stdin open for the child's whole
 * lifetime and only ends it during teardown.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CLAUDE_REMOTE_DEFAULT_BASE_URL } from "./client.js";

export interface WorkerSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** Env keys that must never reach the worker child (subscription OAuth only). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export function buildWorkerSpawnSpec(input: {
  sessionId: string;
  workerJwt: string;
  cwd: string;
  command?: string;
  baseUrl?: string | null;
  /**
   * Opaque epoch token from the worker-claim. Required: the worker aborts with
   * "worker registration failed (missing_epoch)" without CLAUDE_CODE_WORKER_EPOCH,
   * and the registration path is the CCR-v2 path (CLAUDE_CODE_USE_CCR_V2=1).
   */
  workerEpoch?: string | null;
  env?: Record<string, string | undefined>;
}): WorkerSpawnSpec {
  const baseUrl = (input.baseUrl ?? CLAUDE_REMOTE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (typeof value !== "string") continue;
    if (FORBIDDEN_ENV_KEYS.includes(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = input.workerJwt;
  env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 = "1";
  if (input.workerEpoch != null && input.workerEpoch.length > 0) {
    env.CLAUDE_CODE_WORKER_EPOCH = input.workerEpoch;
    env.CLAUDE_CODE_USE_CCR_V2 = "1";
  }
  return {
    command: input.command ?? "claude",
    args: [
      "--print",
      "--sdk-url",
      `${baseUrl}/v1/code/sessions/${input.sessionId}`,
      "--session-id",
      input.sessionId,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-mode",
      "bypassPermissions",
    ],
    env,
    cwd: input.cwd,
  };
}

export interface WorkerChildHooks {
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  /** Called once per complete stdout line (the stream-json event channel). */
  onLine?: (line: string) => void;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> | void;
}

export interface WorkerExit {
  exitCode: number | null;
  signal: string | null;
}

export class ClaudeRemoteWorkerChild {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private exitPromise: Promise<WorkerExit> | null = null;
  private exitResult: WorkerExit | null = null;
  stdout = "";
  stderr = "";

  constructor(
    private readonly spec: WorkerSpawnSpec,
    private readonly hooks: WorkerChildHooks = {},
  ) {}

  get running(): boolean {
    return this.child !== null && this.exitResult === null;
  }

  get exited(): WorkerExit | null {
    return this.exitResult;
  }

  spawn(): void {
    if (this.child) throw new Error("worker child already spawned");
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    // Hold stdin open for the child's lifetime. Never end() it outside stop():
    // a --print child exits on stdin EOF before the cloud message arrives.
    child.stdin.on("error", () => {});

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdout += chunk;
      void this.hooks.onLog?.("stdout", chunk);
      if (this.hooks.onLine) {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
          if (line.trim().length > 0) this.hooks.onLine(line);
          newlineIndex = this.stdoutBuffer.indexOf("\n");
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      void this.hooks.onLog?.("stderr", chunk);
    });

    this.exitPromise = new Promise<WorkerExit>((resolve) => {
      let settled = false;
      const settle = (exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        // Flush any final partial stdout line so a result event without a
        // trailing newline is still delivered to onLine.
        if (this.hooks.onLine && this.stdoutBuffer.trim().length > 0) {
          this.hooks.onLine(this.stdoutBuffer.trim());
          this.stdoutBuffer = "";
        }
        this.exitResult = { exitCode, signal };
        resolve(this.exitResult);
      };
      child.on("exit", (code, signal) => settle(code, signal));
      child.on("error", () => settle(null, null));
    });

    if (child.pid != null) {
      void this.hooks.onSpawn?.({
        pid: child.pid,
        processGroupId: null,
        startedAt: new Date().toISOString(),
      });
    }
  }

  waitForExit(): Promise<WorkerExit> {
    if (!this.exitPromise) throw new Error("worker child not spawned");
    return this.exitPromise;
  }

  /**
   * Teardown: end stdin (lets a healthy child wind down), then SIGTERM after
   * graceMs, then SIGKILL after another graceMs. Resolves once the child exits.
   */
  async stop(graceMs = 5_000): Promise<WorkerExit> {
    const child = this.child;
    if (!child || !this.exitPromise) return { exitCode: null, signal: null };
    if (this.exitResult) return this.exitResult;

    try {
      child.stdin.end();
    } catch {
      // stdin may already be destroyed
    }

    const timers: NodeJS.Timeout[] = [];
    timers.push(
      setTimeout(() => {
        if (!this.exitResult) {
          try {
            child.kill("SIGTERM");
          } catch {
            // already gone
          }
        }
      }, graceMs),
    );
    timers.push(
      setTimeout(() => {
        if (!this.exitResult) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, graceMs * 2),
    );

    try {
      return await this.exitPromise;
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  }
}
