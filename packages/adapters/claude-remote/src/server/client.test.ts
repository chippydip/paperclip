import { describe, it, expect, vi } from "vitest";
import {
  ClaudeRemoteSessionsClient,
  ClaudeRemoteProtocolError,
  SseParser,
  normalizeSessionEvent,
  redactSecrets,
} from "./client.js";

const OAUTH = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKE";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("redactSecrets", () => {
  it("redacts oauth tokens and jwt shapes", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4";
    const out = redactSecrets(`token=${OAUTH} jwt=${jwt}`);
    expect(out).not.toContain("sk-ant-oat01");
    expect(out).not.toContain("eyJhbGc");
    expect(out).toContain("[REDACTED]");
  });
});

describe("ClaudeRemoteSessionsClient headers", () => {
  const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH });

  it("builds the gVf (session) header set", () => {
    const headers = client.buildSessionHeaders();
    expect(headers.Authorization).toBe(`Bearer ${OAUTH}`);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBeTruthy();
    expect(headers["anthropic-client-platform"]).toBeUndefined();
  });

  it("builds the wD (events) header set with client platform", () => {
    const headers = client.buildEventsHeaders();
    expect(headers.Authorization).toBe(`Bearer ${OAUTH}`);
    expect(headers["anthropic-client-platform"]).toBe("claude_code_remote");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("createSession", () => {
  it("sends the captured body and parses the cse id", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.bridge).toEqual({});
      expect(body.title).toBe("paperclip GOLA-8");
      expect(body.config.cwd).toBe("/work");
      expect(body.config.model).toBe("claude-fable-5");
      return jsonResponse({ session: { id: "cse_01ABCDEF", status: "active" } });
    }) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    const created = await client.createSession({ title: "paperclip GOLA-8", cwd: "/work", model: "claude-fable-5" });
    expect(created.id).toBe("cse_01ABCDEF");
  });

  it("throws a protocol error when the id is not a cse_ id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: { id: "bogus" } })) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    await expect(client.createSession({ title: "t", cwd: "/work" })).rejects.toBeInstanceOf(ClaudeRemoteProtocolError);
  });

  it("redacts the bearer token in protocol errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 500)) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    const err = await client.createSession({ title: "t", cwd: "/work" }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeRemoteProtocolError);
    expect(String(err.message)).not.toContain(OAUTH);
  });
});

describe("claimWorker", () => {
  it("parses the worker jwt and ttl", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/v1/code/sessions/cse_01ABCDEF/bridge");
      return jsonResponse({ worker_jwt: "eyJfake.worker.jwt", worker_epoch: "1", api_base_url: "https://api.anthropic.com", expires_in: 14400 });
    }) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    const claim = await client.claimWorker("cse_01ABCDEF");
    expect(claim.workerJwt).toBe("eyJfake.worker.jwt");
    expect(claim.expiresIn).toBe(14400);
    // worker_epoch is captured as the string "1" and preserved verbatim.
    expect(claim.workerEpoch).toBe("1");
  });

  it("coerces a numeric worker_epoch to a string", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ worker_jwt: "eyJfake", worker_epoch: 2, expires_in: 14400 }),
    ) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    const claim = await client.claimWorker("cse_X");
    expect(claim.workerEpoch).toBe("2");
  });
});

describe("sendUserMessage", () => {
  it("posts the captured events envelope", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/v1/code/sessions/cse_X/events");
      const body = JSON.parse(init.body as string);
      const payload = body.events[0].payload;
      expect(payload.type).toBe("user");
      expect(payload.message.role).toBe("user");
      expect(payload.message.content[0]).toEqual({ type: "text", text: "hello there" });
      expect(payload.priority).toBe("next");
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    await client.sendUserMessage("cse_X", "hello there");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps a 404 to an unknown-session protocol error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch;
    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    const err = await client.sendUserMessage("cse_dead", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeRemoteProtocolError);
    expect(err.status).toBe(404);
  });
});

describe("SseParser", () => {
  it("emits frames on blank-line boundaries with multi-line data", () => {
    const parser = new SseParser();
    const frames: Array<{ event: string | null; data: string; id: string | null }> = [];
    parser.feed("event: message\ndata: {\"a\":1}\n\nid: 7\ndata: line1\ndata: line2\n\n", (f) => frames.push(f));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: "message", data: '{"a":1}', id: null });
    expect(frames[1]).toEqual({ event: null, data: "line1\nline2", id: "7" });
  });

  it("handles CRLF and chunk splits across the boundary", () => {
    const parser = new SseParser();
    const frames: Array<{ data: string }> = [];
    parser.feed("data: par", (f) => frames.push(f));
    parser.feed("tial\r\n\r\n", (f) => frames.push(f));
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe("partial");
  });
});

describe("normalizeSessionEvent", () => {
  it("reads seq from sequence_num or seq, and type from several keys", () => {
    expect(normalizeSessionEvent({ sequence_num: 5, event_type: "user", payload: { type: "user" } })).toMatchObject({ seq: 5, eventType: "user" });
    expect(normalizeSessionEvent({ seq: 9, type: "result" })).toMatchObject({ seq: 9, eventType: "result" });
    expect(normalizeSessionEvent({ payload: { type: "assistant" } })).toMatchObject({ seq: null, eventType: "assistant" });
  });
});

describe("streamEvents seq-replay", () => {
  it("drops replayed events with seq <= last seen and reconnects with from_sequence_num", async () => {
    const sse1 =
      'data: {"seq":1,"type":"user","payload":{"type":"user"}}\n\n' +
      'data: {"seq":2,"type":"assistant","payload":{"type":"assistant"}}\n\n';
    // On reconnect the server replays seq 2 (<= lastSeq) plus a fresh seq 3.
    const sse2 =
      'data: {"seq":2,"type":"assistant","payload":{"type":"assistant"}}\n\n' +
      'data: {"seq":3,"type":"result","payload":{"type":"result"}}\n\n';
    const urls: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      call += 1;
      return new Response(call === 1 ? sse1 : sse2, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const client = new ClaudeRemoteSessionsClient({ oauthToken: OAUTH, fetchImpl });
    const seen: number[] = [];
    const controller = new AbortController();
    await client.streamEvents("cse_X", {
      onEvent: (event) => {
        if (event.seq != null) seen.push(event.seq);
        if (event.seq === 3) controller.abort();
      },
      signal: controller.signal,
    });

    expect(seen).toEqual([1, 2, 3]); // seq 2 replayed on reconnect was deduped
    expect(urls[1]).toContain("from_sequence_num=2");
  });
});
