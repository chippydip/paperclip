/**
 * Client for the captured remote-control cloud-session protocol
 * (docs/design/interactive-claude-adapter.md §6 Item 1).
 *
 * This API is private and undocumented; every call funnels through
 * requestJson() so drift (non-2xx / schema mismatch) surfaces as a single
 * ClaudeRemoteProtocolError the adapter maps to errorCode
 * "claude_remote_protocol".
 *
 * Auth is the claude.ai subscription OAuth access token (sk-ant-oat01…).
 * A raw ANTHROPIC_API_KEY does not work for cloud sessions (spike-verified).
 * Tokens and worker JWTs must never appear in logs or errors — see redactSecrets().
 */

export const CLAUDE_REMOTE_DEFAULT_BASE_URL = "https://api.anthropic.com";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_CLIENT_PLATFORM = "claude_code_remote";
const DEFAULT_USER_AGENT = "paperclip-adapter-claude-remote/0.1";

const SECRET_SHAPES_RE = /(sk-ant-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{4,}){1,4})/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_SHAPES_RE, "[REDACTED]");
}

export class ClaudeRemoteProtocolError extends Error {
  readonly status: number | null;
  readonly path: string;
  readonly bodySnippet: string | null;

  constructor(input: { message: string; status: number | null; path: string; body?: string | null }) {
    const snippet = input.body ? redactSecrets(input.body).slice(0, 400) : null;
    super(redactSecrets(`${input.message} (${input.path}${input.status != null ? ` -> ${input.status}` : ""})${snippet ? `: ${snippet}` : ""}`));
    this.name = "ClaudeRemoteProtocolError";
    this.status = input.status;
    this.path = input.path;
    this.bodySnippet = snippet;
  }
}

/** 404/410 on a resumed session means it is unknown or archived server-side. */
export function isUnknownSessionStatus(status: number | null): boolean {
  return status === 404 || status === 410;
}

export function isAuthStatus(status: number | null): boolean {
  return status === 401 || status === 403;
}

export interface ClaudeRemoteClientOptions {
  oauthToken: string;
  baseUrl?: string;
  clientPlatform?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface CreateSessionInput {
  title: string;
  cwd: string;
  model?: string | null;
  tags?: string[];
}

export interface CreatedSession {
  id: string;
  raw: Record<string, unknown>;
}

export interface WorkerClaim {
  workerJwt: string;
  /** Opaque epoch token (captured as the string "1"); required by worker registration. */
  workerEpoch: string | null;
  apiBaseUrl: string | null;
  expiresIn: number | null;
}

export interface SessionEvent {
  seq: number | null;
  eventId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalize one event envelope from the events stream/list into a SessionEvent. */
export function normalizeSessionEvent(raw: Record<string, unknown>): SessionEvent {
  const payload = asRecord(raw.payload);
  return {
    seq: readNumber(raw.seq) ?? readNumber(raw.sequence_num) ?? readNumber(raw.sequenceNum),
    eventId: readString(raw.event_id) ?? readString(raw.uuid) ?? readString(raw.id),
    eventType:
      readString(raw.event_type) ??
      readString(raw.type) ??
      (payload ? readString(payload.type) ?? "" : ""),
    payload,
    raw,
  };
}

/**
 * Incremental server-sent-events parser. Feed raw text chunks; emits
 * { event, data, id } frames on blank-line boundaries.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | null = null;
  private lastId: string | null = null;

  feed(chunk: string, onFrame: (frame: { event: string | null; data: string; id: string | null }) => void): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.consumeLine(line, onFrame);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private consumeLine(line: string, onFrame: (frame: { event: string | null; data: string; id: string | null }) => void): void {
    if (line.length === 0) {
      if (this.dataLines.length > 0) {
        onFrame({ event: this.eventName, data: this.dataLines.join("\n"), id: this.lastId });
      }
      this.dataLines = [];
      this.eventName = null;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
    else if (field === "id") this.lastId = value;
  }
}

export class ClaudeRemoteSessionsClient {
  private readonly baseUrl: string;
  private readonly oauthToken: string;
  private readonly clientPlatform: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ClaudeRemoteClientOptions) {
    this.baseUrl = (options.baseUrl ?? CLAUDE_REMOTE_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.oauthToken = options.oauthToken;
    this.clientPlatform = options.clientPlatform ?? DEFAULT_CLIENT_PLATFORM;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /** Captured "gVf" header shape: session create / worker-claim / archive. */
  buildSessionHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.oauthToken}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };
  }

  /** Captured "wD" header shape: events send / read / stream. */
  buildEventsHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.oauthToken}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-client-platform": this.clientPlatform,
      "Content-Type": "application/json",
    };
  }

  sessionUrl(sessionId: string, suffix = ""): string {
    return `${this.baseUrl}/v1/code/sessions${sessionId ? `/${sessionId}` : ""}${suffix}`;
  }

  private async requestJson(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    what: string;
  }): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${input.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        headers: input.headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ClaudeRemoteProtocolError({
        message: `${input.what} request failed: ${err instanceof Error ? err.message : String(err)}`,
        status: null,
        path: input.path,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new ClaudeRemoteProtocolError({
        message: `${input.what} returned HTTP ${response.status}`,
        status: response.status,
        path: input.path,
        body: text,
      });
    }
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      return asRecord(parsed) ?? {};
    } catch {
      throw new ClaudeRemoteProtocolError({
        message: `${input.what} returned unparseable JSON`,
        status: response.status,
        path: input.path,
        body: text,
      });
    }
  }

  /** POST /v1/code/sessions — captured create body: {title, bridge:{}, tags?, config:{cwd, model?}}. */
  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const body: Record<string, unknown> = {
      title: input.title,
      bridge: {},
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      config: {
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
      },
    };
    const json = await this.requestJson({
      method: "POST",
      path: "/v1/code/sessions",
      headers: this.buildSessionHeaders(),
      body,
      what: "CreateSession",
    });
    const session = asRecord(json.session) ?? json;
    const id = readString(session.id);
    if (!id || !id.startsWith("cse_")) {
      throw new ClaudeRemoteProtocolError({
        message: "CreateSession response did not include a cse_* session id",
        status: 200,
        path: "/v1/code/sessions",
        body: JSON.stringify(json),
      });
    }
    return { id, raw: session };
  }

  /** POST /v1/code/sessions/{id}/bridge — worker-claim, mints the worker JWT (4h TTL). */
  async claimWorker(sessionId: string): Promise<WorkerClaim> {
    const json = await this.requestJson({
      method: "POST",
      path: `/v1/code/sessions/${sessionId}/bridge`,
      headers: this.buildSessionHeaders(),
      body: {},
      what: "WorkerClaim",
    });
    const workerJwt = readString(json.worker_jwt);
    if (!workerJwt) {
      throw new ClaudeRemoteProtocolError({
        message: "WorkerClaim response did not include worker_jwt",
        status: 200,
        path: `/v1/code/sessions/${sessionId}/bridge`,
        body: JSON.stringify(Object.keys(json)),
      });
    }
    const epochRaw = json.worker_epoch;
    return {
      workerJwt,
      workerEpoch:
        typeof epochRaw === "string" && epochRaw.length > 0
          ? epochRaw
          : typeof epochRaw === "number" && Number.isFinite(epochRaw)
          ? String(epochRaw)
          : null,
      apiBaseUrl: readString(json.api_base_url),
      expiresIn: readNumber(json.expires_in),
    };
  }

  /** POST /v1/code/sessions/{id}/events — send one user message into the session. */
  async sendUserMessage(
    sessionId: string,
    text: string,
    options?: { priority?: string },
  ): Promise<Record<string, unknown>> {
    const body = {
      events: [
        {
          payload: {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text }],
            },
            priority: options?.priority ?? "next",
          },
        },
      ],
    };
    return this.requestJson({
      method: "POST",
      path: `/v1/code/sessions/${sessionId}/events`,
      headers: this.buildEventsHeaders(),
      body,
      what: "SendMessage",
    });
  }

  /** POST /v1/code/sessions/{id}/archive — end the session server-side. */
  async archiveSession(sessionId: string): Promise<void> {
    await this.requestJson({
      method: "POST",
      path: `/v1/code/sessions/${sessionId}/archive`,
      headers: this.buildSessionHeaders(),
      body: {},
      what: "ArchiveSession",
    });
  }

  /** GET /v1/code/sessions/{id}/events — list events (non-streaming read). */
  async listEvents(sessionId: string, options?: { fromSequenceNum?: number | null }): Promise<SessionEvent[]> {
    const query =
      options?.fromSequenceNum != null ? `?from_sequence_num=${options.fromSequenceNum}` : "";
    const json = await this.requestJson({
      method: "GET",
      path: `/v1/code/sessions/${sessionId}/events${query}`,
      headers: this.buildEventsHeaders(),
      what: "ListEvents",
    });
    const events = Array.isArray(json.events) ? json.events : [];
    return events
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(normalizeSessionEvent);
  }

  buildEventsStreamUrl(sessionId: string, fromSequenceNum?: number | null): string {
    const query = fromSequenceNum != null ? `?from_sequence_num=${fromSequenceNum}` : "";
    return `${this.baseUrl}/v1/code/sessions/${sessionId}/events/stream${query}`;
  }

  /**
   * GET /v1/code/sessions/{id}/events/stream — SSE event stream with
   * seq-replay reconnect (?from_sequence_num=<last seen seq>, observed in the
   * rc SSETransport logs). Events with seq <= the last seen seq are dropped so
   * replayed frames never double-emit. Resolves when `signal` aborts or
   * (when reconnect is disabled) the stream ends.
   */
  async streamEvents(
    sessionId: string,
    options: {
      onEvent: (event: SessionEvent) => void | Promise<void>;
      fromSequenceNum?: number | null;
      signal?: AbortSignal;
      reconnect?: boolean;
      maxReconnectDelayMs?: number;
      onLog?: (message: string) => void | Promise<void>;
    },
  ): Promise<{ lastSeq: number | null }> {
    let lastSeq: number | null = options.fromSequenceNum ?? null;
    const reconnect = options.reconnect ?? true;
    const maxDelay = options.maxReconnectDelayMs ?? 15_000;
    let attempt = 0;

    while (true) {
      if (options.signal?.aborted) return { lastSeq };
      const url = this.buildEventsStreamUrl(sessionId, lastSeq);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { ...this.buildEventsHeaders(), Accept: "text/event-stream" },
          signal: options.signal,
        });
      } catch (err) {
        if (options.signal?.aborted) return { lastSeq };
        if (!reconnect) {
          throw new ClaudeRemoteProtocolError({
            message: `EventStream connect failed: ${err instanceof Error ? err.message : String(err)}`,
            status: null,
            path: `/v1/code/sessions/${sessionId}/events/stream`,
          });
        }
        attempt += 1;
        const backoff = Math.min(maxDelay, 500 * 2 ** Math.min(attempt, 5));
        await options.onLog?.(`[claude-remote] event stream connect failed; retrying in ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new ClaudeRemoteProtocolError({
          message: `EventStream returned HTTP ${response.status}`,
          status: response.status,
          path: `/v1/code/sessions/${sessionId}/events/stream`,
          body: text,
        });
      }
      attempt = 0;

      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      const frames: Array<{ event: string | null; data: string; id: string | null }> = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }), (frame) => frames.push(frame));
          while (frames.length > 0) {
            const frame = frames.shift()!;
            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              continue;
            }
            const record = asRecord(parsed);
            if (!record) continue;
            const event = normalizeSessionEvent(record);
            // The client /events/stream framing carries the sequence in the SSE
            // `id:` field rather than the JSON body, so fall back to it.
            const frameSeq =
              event.seq ?? (frame.id != null && /^\d+$/.test(frame.id) ? Number(frame.id) : null);
            if (frameSeq != null && lastSeq != null && frameSeq <= lastSeq) continue;
            if (frameSeq != null) lastSeq = frameSeq;
            await options.onEvent(event);
          }
        }
      } catch (err) {
        if (options.signal?.aborted) return { lastSeq };
        if (!reconnect) {
          throw new ClaudeRemoteProtocolError({
            message: `EventStream read failed: ${err instanceof Error ? err.message : String(err)}`,
            status: null,
            path: `/v1/code/sessions/${sessionId}/events/stream`,
          });
        }
        await options.onLog?.("[claude-remote] event stream dropped; reconnecting with seq replay");
        continue;
      } finally {
        reader.releaseLock();
      }

      if (options.signal?.aborted || !reconnect) return { lastSeq };
      await options.onLog?.("[claude-remote] event stream ended; reconnecting with seq replay");
    }
  }
}
