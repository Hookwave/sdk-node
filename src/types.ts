/** JSON-serialisable values — the shape Hookwave accepts on the wire. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Per-event options. `emit(type, payload, options?)` — every field
 * optional, omit when you don't need it.
 */
export interface EmitOptions {
  /** Dedup at Hookwave ingest within 24h. Same key → same event. */
  idempotencyKey?: string;
  /** Override the server-side timestamp. Useful for backfill. */
  occurredAt?: Date | string;
  /** Free-form fields surfaced in the dashboard + audit log. Not part of the payload. */
  metadata?: JsonObject;
  /** Hint a preferred connection by slug (still fans out to other matching connections). */
  connection?: string;
  /** Trace ID for cross-system correlation; surfaced on deliveries. */
  correlationId?: string;
}

/** A queued event waiting in the buffer. Internal shape. */
export interface QueuedEvent {
  eventType: string;
  payload: JsonObject;
  options: EmitOptions;
  queuedAt: number;
}

/** Wire shape sent to POST /v1/ingest/batch. */
export interface WireEvent {
  type: string;
  payload: JsonObject;
  idempotency_key?: string;
  occurred_at?: string;
  metadata?: JsonObject;
  connection?: string;
  correlation_id?: string;
}

export interface BatchRequest {
  events: WireEvent[];
}

export interface BatchResponse {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

export interface EmitSyncResult {
  eventId: string;
  status: "accepted";
}

export interface HookwaveOptions {
  /** Source-scoped write key — `src_live_…` or `src_test_…`. */
  sourceKey: string;
  /** Ingest base URL. Override only for testing / proxies. */
  baseUrl?: string;
  /** Auto-flush cadence. Default 1000ms. */
  flushInterval?: number;
  /** Max events per HTTP request. Default 100. */
  maxBatchSize?: number;
  /** Per-batch retry attempts on network / 5xx. Default 5. */
  maxRetries?: number;
  /** Default 30000ms. Per-request timeout. */
  requestTimeout?: number;
  /** Callback for per-event failures after all retries. Default: console.error. */
  onError?: (err: Error, events: QueuedEvent[]) => void;
  /** Callback for successful flushes — observability hook. */
  onFlush?: (count: number) => void;
  /**
   * Last-chance hook to mutate or drop an event before it leaves the
   * process. Return `null` to drop. Useful for PII scrubbing.
   */
  onBeforeEmit?: (eventType: string, payload: JsonObject) => JsonObject | null;
}
