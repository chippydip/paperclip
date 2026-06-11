/**
 * Live acceptance probe for GOLA-8 (run on STARFORGE with a claude.ai login).
 * NOT a unit test — it talks to the live cloud-session API and spawns a real
 * worker child. It exercises the three acceptance criteria:
 *   1. closed-loop turn: create -> claim -> spawn worker -> send -> result parsed
 *   2. rate_limit_event five_hour frame captured
 *   3. multi-turn: second message into the same cse session -> second result
 *
 * Usage: pnpm --filter @paperclipai/adapter-claude-remote probe:live
 * Tokens/JWTs are never printed — only shapes and parsed result fields.
 */
import { parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";
import { readClaudeToken } from "@paperclipai/adapter-claude-local/server";
import { ClaudeRemoteSessionsClient } from "../server/client.js";
import { ClaudeRemoteWorkerChild, buildWorkerSpawnSpec } from "../server/worker.js";
import { parseRateLimitEvent, type ClaudeRemoteRateLimitInfo } from "../server/rate-limit-state.js";

const BASE_URL = process.env.CLAUDE_REMOTE_BASE_URL ?? "https://api.anthropic.com";
const CWD = process.env.CLAUDE_REMOTE_PROBE_CWD ?? process.cwd();
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_REMOTE_PROBE_TIMEOUT_MS ?? 120_000);

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function driveTurn(
  client: ClaudeRemoteSessionsClient,
  sessionId: string,
  workerJwt: string,
  workerEpoch: string | null,
  prompt: string,
): Promise<{ result: Record<string, unknown> | null; rateLimit: ClaudeRemoteRateLimitInfo | null; summary: string }> {
  let rateLimit: ClaudeRemoteRateLimitInfo | null = null;
  const lines: string[] = [];
  let resolveResult: ((value: Record<string, unknown> | null) => void) | null = null;
  const resultPromise = new Promise<Record<string, unknown> | null>((resolve) => (resolveResult = resolve));

  const worker = new ClaudeRemoteWorkerChild(
    buildWorkerSpawnSpec({ sessionId, workerJwt, workerEpoch, cwd: CWD, baseUrl: BASE_URL, env: process.env }),
    {},
  );

  worker.spawn();
  log(`  worker spawned (pid set), holding stdin open`);
  await client.sendUserMessage(sessionId, prompt);
  log(`  user message posted; reading client events stream`);

  const controller = new AbortController();
  const streamPromise = client
    .streamEvents(sessionId, {
      signal: controller.signal,
      onEvent: (event) => {
        const payload = event.payload;
        if (!payload) return;
        const type = typeof payload.type === "string" ? payload.type : "";
        lines.push(JSON.stringify(payload));
        if (type === "rate_limit_event") {
          const info = parseRateLimitEvent(payload);
          if (info) {
            rateLimit = info;
            log(`  [rate_limit_event] type=${info.rateLimitType} status=${info.status} resetsAt=${info.resetsAt}`);
          }
        }
        if (type === "result") {
          resolveResult?.(payload);
          controller.abort();
        }
      },
    })
    .catch(() => {});

  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS));
  const outcome = await Promise.race([
    resultPromise.then(() => "result" as const),
    worker.waitForExit().then(() => "exit" as const),
    timeout,
  ]);
  log(`  turn settled via: ${outcome}`);
  controller.abort();
  await streamPromise;
  await worker.stop(5_000);

  const parsed = parseClaudeStreamJson(lines.join("\n"));
  return { result: parsed.resultJson, rateLimit, summary: parsed.summary };
}

async function main(): Promise<void> {
  const oauthToken = await readClaudeToken();
  if (!oauthToken) {
    log("FAIL: no claude.ai OAuth token (~/.claude/.credentials.json). Run `claude login`.");
    process.exit(1);
    return;
  }
  log(`OAuth token present (shape: ${oauthToken.slice(0, 11)}…, ${oauthToken.length} chars)`);

  const client = new ClaudeRemoteSessionsClient({ oauthToken, baseUrl: BASE_URL });

  log("\n== Creating cloud session ==");
  const session = await client.createSession({ title: "paperclip GOLA-8 live probe", cwd: CWD });
  log(`  session: ${session.id}`);

  log("== Claiming worker (bridge) ==");
  const claim = await client.claimWorker(session.id);
  log(`  worker JWT minted (shape: ${claim.workerJwt.slice(0, 3)}…, ttl=${claim.expiresIn}s, epoch=${claim.workerEpoch})`);

  log("\n== Acceptance #1: closed-loop turn ==");
  const turn1 = await driveTurn(client, session.id, claim.workerJwt, claim.workerEpoch, "Reply with exactly one word: pong");
  if (!turn1.result) {
    log("FAIL #1: no result event parsed");
    await client.archiveSession(session.id).catch(() => {});
    process.exit(1);
    return;
  }
  log(`  PASS #1: result parsed — summary="${turn1.summary.slice(0, 80)}" cost=${turn1.result.total_cost_usd} turns=${turn1.result.num_turns}`);

  log("\n== Acceptance #2: rate_limit_event capture ==");
  if (turn1.rateLimit && turn1.rateLimit.rateLimitType === "five_hour") {
    log(`  PASS #2: five_hour frame captured (resetsAt=${turn1.rateLimit.resetsAt}, status=${turn1.rateLimit.status})`);
  } else {
    log(`  WARN #2: no five_hour rate_limit_event frame on this turn (frames are emitted opportunistically)`);
  }

  log("\n== Acceptance #3: multi-turn resume (same cse session) ==");
  const claim2 = await client.claimWorker(session.id);
  const turn2 = await driveTurn(
    client,
    session.id,
    claim2.workerJwt,
    claim2.workerEpoch,
    "What single word did you just reply with? Answer with only that word.",
  );
  if (!turn2.result) {
    log("FAIL #3: no second result event parsed");
    await client.archiveSession(session.id).catch(() => {});
    process.exit(1);
    return;
  }
  const carried = /pong/i.test(turn2.summary);
  log(`  result2 summary="${turn2.summary.slice(0, 80)}" context-carried=${carried}`);
  log(carried ? "  PASS #3: context carried across turns in the same session" : "  WARN #3: second result arrived but did not echo prior context");

  log("\n== Archiving session ==");
  await client.archiveSession(session.id).catch(() => {});
  log("Done.");
}

main().catch((err) => {
  log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
