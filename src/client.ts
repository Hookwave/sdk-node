import { sendBatch } from "./transport.js";
import type {
  EmitOptions,
  EmitSyncResult,
  HookwaveOptions,
  JsonObject,
  QueuedEvent,
  WireEvent,
} from "./types.js";

/**
 * Hookwave SDK client.
 *
 * ```ts
 * const hw = new Hookwave({ sourceKey: process.env.HOOKWAVE_SOURCE_KEY! });
 *
 * hw.emit("user.signed_up", { userId, email });
 *
 * // before process exit (Lambda, Vercel, etc.)
 * await hw.shutdown();
 * ```
 *
 * `emit` is fire-and-forget — events are buffered and flushed on a
 * timer or when the buffer hits `maxBatchSize`. Failures retry with
 * exponential backoff; persistent failures go to `onError`.
 *
 * Use `emitSync` only when the response truly depends on delivery.
 * Always call `shutdown()` before the process exits so the buffer
 * flushes cleanly.
 */
export class Hookwave {
  readonly #sourceKey: string;
  readonly #baseUrl: string;
  readonly #flushInterval: number;
  readonly #maxBatchSize: number;
  readonly #maxRetries: number;
  readonly #requestTimeout: number;
  readonly #onError: NonNullable<HookwaveOptions["onError"]>;
  readonly #onFlush: NonNullable<HookwaveOptions["onFlush"]>;
  readonly #onBeforeEmit: HookwaveOptions["onBeforeEmit"] | undefined;

  #buffer: QueuedEvent[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #pendingFlush: Promise<void> | null = null;
  #closed = false;

  constructor(options: HookwaveOptions) {
    if (!options.sourceKey) {
      throw new Error(
        "Hookwave: `sourceKey` is required. Generate one in the dashboard at https://hookwave.dev/dashboard/sources",
      );
    }
    if (
      !options.sourceKey.startsWith("src_live_") &&
      !options.sourceKey.startsWith("src_test_")
    ) {
      throw new Error(
        "Hookwave: `sourceKey` must start with `src_live_` or `src_test_`. Did you paste an API token by mistake?",
      );
    }

    this.#sourceKey = options.sourceKey;
    this.#baseUrl = options.baseUrl ?? "https://ingest.hookwave.dev";
    this.#flushInterval = options.flushInterval ?? 1000;
    this.#maxBatchSize = options.maxBatchSize ?? 100;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#requestTimeout = options.requestTimeout ?? 30_000;
    this.#onError =
      options.onError ??
      ((err) => {
        // Default: log to stderr so failures don't get swallowed silently.
        console.error("[hookwave] flush failed:", err);
      });
    this.#onFlush = options.onFlush ?? (() => {});
    this.#onBeforeEmit = options.onBeforeEmit;

    this.#startTimer();
  }

  /**
   * Queue an event. Fire-and-forget — returns immediately. Errors
   * during the eventual flush go to `onError`.
   */
  emit(eventType: string, payload: JsonObject, options: EmitOptions = {}): void {
    if (this.#closed) {
      throw new Error("Hookwave: client is shut down; cannot emit more events.");
    }
    const finalPayload = this.#onBeforeEmit
      ? this.#onBeforeEmit(eventType, payload)
      : payload;
    if (finalPayload === null) return;

    this.#buffer.push({
      eventType,
      payload: finalPayload,
      options,
      queuedAt: Date.now(),
    });

    if (this.#buffer.length >= this.#maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Emit and await delivery. Throws on network / 5xx failure after
   * retries. Use sparingly — `emit` is the right choice 95% of the
   * time.
   */
  async emitSync(
    eventType: string,
    payload: JsonObject,
    options: EmitOptions = {},
  ): Promise<EmitSyncResult> {
    if (this.#closed) {
      throw new Error("Hookwave: client is shut down; cannot emit more events.");
    }
    const finalPayload = this.#onBeforeEmit
      ? this.#onBeforeEmit(eventType, payload)
      : payload;
    if (finalPayload === null) {
      throw new Error(
        "Hookwave: event was dropped by onBeforeEmit; cannot emitSync a dropped event.",
      );
    }

    const wire: WireEvent = toWire({
      eventType,
      payload: finalPayload,
      options,
      queuedAt: Date.now(),
    });
    const response = await sendBatch({
      baseUrl: this.#baseUrl,
      sourceKey: this.#sourceKey,
      body: { events: [wire] },
      requestTimeout: this.#requestTimeout,
      maxRetries: this.#maxRetries,
    });

    if (response.rejected.length > 0) {
      throw new Error(
        `Hookwave: event rejected — ${response.rejected[0]?.reason ?? "unknown"}`,
      );
    }
    return { eventId: crypto.randomUUID(), status: "accepted" };
  }

  /**
   * Force the buffer to flush now. Resolves when the in-flight batch
   * (and any concurrent caller's batch) completes. Safe to call
   * concurrently — flushes coalesce.
   */
  async flush(): Promise<void> {
    if (this.#pendingFlush) return this.#pendingFlush;
    if (this.#buffer.length === 0) return;

    const batch = this.#buffer.splice(0, this.#buffer.length);
    this.#pendingFlush = this.#dispatchBatch(batch).finally(() => {
      this.#pendingFlush = null;
    });
    return this.#pendingFlush;
  }

  /**
   * Flush remaining events and stop the auto-flush timer. Must be
   * called before process exit in serverless environments.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopTimer();

    if (this.#buffer.length === 0 && !this.#pendingFlush) return;

    const flushPromise = this.flush();
    if (timeoutMs <= 0) {
      await flushPromise;
      return;
    }
    await Promise.race([
      flushPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Hookwave: shutdown timed out after ${timeoutMs}ms with events still in buffer`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]).catch((err) => {
      this.#onError(err as Error, this.#buffer);
    });
  }

  // ---- internals ---------------------------------------------------

  #startTimer(): void {
    this.#timer = setInterval(() => {
      if (this.#buffer.length > 0) void this.flush();
    }, this.#flushInterval);
    // Don't keep the Node process alive purely for the flush timer.
    if (typeof this.#timer.unref === "function") this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #dispatchBatch(batch: QueuedEvent[]): Promise<void> {
    try {
      const events = batch.map(toWire);
      const response = await sendBatch({
        baseUrl: this.#baseUrl,
        sourceKey: this.#sourceKey,
        body: { events },
        requestTimeout: this.#requestTimeout,
        maxRetries: this.#maxRetries,
      });
      this.#onFlush(response.accepted);

      if (response.rejected.length > 0) {
        const rejectedEvents = response.rejected
          .map((r) => batch[r.index])
          .filter((e): e is QueuedEvent => e !== undefined);
        this.#onError(
          new Error(
            `Hookwave: ${response.rejected.length} of ${batch.length} events rejected`,
          ),
          rejectedEvents,
        );
      }
    } catch (err) {
      this.#onError(err as Error, batch);
    }
  }
}

function toWire(e: QueuedEvent): WireEvent {
  const wire: WireEvent = {
    type: e.eventType,
    payload: e.payload,
  };
  if (e.options.idempotencyKey) wire.idempotency_key = e.options.idempotencyKey;
  if (e.options.occurredAt) {
    wire.occurred_at =
      typeof e.options.occurredAt === "string"
        ? e.options.occurredAt
        : e.options.occurredAt.toISOString();
  }
  if (e.options.metadata) wire.metadata = e.options.metadata;
  if (e.options.connection) wire.connection = e.options.connection;
  if (e.options.correlationId) wire.correlation_id = e.options.correlationId;
  return wire;
}
