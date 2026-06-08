import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hookwave } from "./client.js";

/**
 * Unit tests for the public API surface. Network calls are stubbed via
 * a fetch mock so the tests are hermetic — no real ingest endpoint
 * needed. The transport layer's retry logic gets its own coverage in
 * transport.test.ts later.
 */

const TEST_KEY = "src_test_abcdefghijklmnopqrstuvwxyz";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hookwave constructor", () => {
  it("rejects missing source key", () => {
    expect(() => new Hookwave({ sourceKey: "" })).toThrow(/sourceKey.*required/i);
  });

  it("rejects malformed source key", () => {
    expect(() => new Hookwave({ sourceKey: "not_a_real_key" })).toThrow(
      /src_live_.*src_test_/,
    );
  });

  it("accepts a valid test key", () => {
    expect(() => new Hookwave({ sourceKey: TEST_KEY })).not.toThrow();
  });
});

describe("emit", () => {
  it("queues events and flushes on shutdown", async () => {
    const hw = new Hookwave({ sourceKey: TEST_KEY, flushInterval: 10_000 });
    hw.emit("user.signed_up", { userId: "u_1" });
    hw.emit("user.signed_up", { userId: "u_2" });
    await hw.shutdown();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({
      type: "user.signed_up",
      payload: { userId: "u_1" },
    });
  });

  it("flushes when buffer hits maxBatchSize", async () => {
    const hw = new Hookwave({
      sourceKey: TEST_KEY,
      flushInterval: 10_000,
      maxBatchSize: 3,
    });
    hw.emit("a", {});
    hw.emit("a", {});
    hw.emit("a", {}); // triggers flush
    // Give the microtask queue a tick to run the in-flight flush
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await hw.shutdown();
  });

  it("applies onBeforeEmit transformation", async () => {
    const hw = new Hookwave({
      sourceKey: TEST_KEY,
      flushInterval: 10_000,
      onBeforeEmit: (_type, payload) => ({ ...payload, scrubbed: true }),
    });
    hw.emit("evt", { email: "x@y.z" });
    await hw.shutdown();

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.events[0].payload).toEqual({ email: "x@y.z", scrubbed: true });
  });

  it("drops events when onBeforeEmit returns null", async () => {
    const hw = new Hookwave({
      sourceKey: TEST_KEY,
      flushInterval: 10_000,
      onBeforeEmit: () => null,
    });
    hw.emit("evt", {});
    await hw.shutdown();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes optional fields on the wire", async () => {
    const hw = new Hookwave({ sourceKey: TEST_KEY, flushInterval: 10_000 });
    const occurredAt = new Date("2026-01-01T00:00:00Z");
    hw.emit("evt", { x: 1 }, {
      idempotencyKey: "key_1",
      occurredAt,
      metadata: { trace: "abc" },
      connection: "ops-alerts",
      correlationId: "req_1",
    });
    await hw.shutdown();

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.events[0]).toEqual({
      type: "evt",
      payload: { x: 1 },
      idempotency_key: "key_1",
      occurred_at: occurredAt.toISOString(),
      metadata: { trace: "abc" },
      connection: "ops-alerts",
      correlation_id: "req_1",
    });
  });

  it("rejects emits after shutdown", async () => {
    const hw = new Hookwave({ sourceKey: TEST_KEY });
    await hw.shutdown();
    expect(() => hw.emit("evt", {})).toThrow(/shut down/);
  });
});

describe("emitSync", () => {
  it("awaits the network round-trip", async () => {
    const hw = new Hookwave({ sourceKey: TEST_KEY });
    const result = await hw.emitSync("evt", {});
    expect(result.status).toBe("accepted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await hw.shutdown();
  });

  it("throws when the server rejects the event", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accepted: 0,
          rejected: [{ index: 0, reason: "schema_drift" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const hw = new Hookwave({ sourceKey: TEST_KEY });
    await expect(hw.emitSync("evt", {})).rejects.toThrow(/schema_drift/);
    await hw.shutdown();
  });
});

describe("shutdown", () => {
  it("is idempotent", async () => {
    const hw = new Hookwave({ sourceKey: TEST_KEY });
    await hw.shutdown();
    await hw.shutdown(); // should not throw
  });

  it("flushes pending events", async () => {
    const hw = new Hookwave({ sourceKey: TEST_KEY, flushInterval: 10_000 });
    hw.emit("evt", {});
    await hw.shutdown();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("error handling", () => {
  it("routes flush failures to onError", async () => {
    fetchMock.mockResolvedValue(
      new Response("nope", { status: 400 }), // 400 = non-retryable
    );
    const onError = vi.fn();
    const hw = new Hookwave({
      sourceKey: TEST_KEY,
      flushInterval: 10_000,
      onError,
    });
    hw.emit("evt", {});
    await hw.shutdown();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
