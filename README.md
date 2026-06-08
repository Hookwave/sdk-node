# @hookwave/sdk

Official Node.js SDK for [Hookwave](https://hookwave.dev) — emit events into a Hookwave source. Batched, retried, fire-and-forget.

```sh
npm install @hookwave/sdk
# or pnpm add @hookwave/sdk
# or yarn add @hookwave/sdk
```

## Quickstart

```ts
import { Hookwave } from "@hookwave/sdk";

const hw = new Hookwave({
  sourceKey: process.env.HOOKWAVE_SOURCE_KEY!, // src_live_… or src_test_…
});

hw.emit("user.signed_up", {
  userId: "u_123",
  email: "ruben@hookwave.dev",
  plan: "pro",
});

// Before process exit (Lambda, Vercel Edge, etc.):
await hw.shutdown();
```

Get a source key in the dashboard at [hookwave.dev/dashboard/sources](https://hookwave.dev/dashboard/sources) → pick a source → **Generate SDK key**.

## What the SDK does

- Buffers events and flushes in batches (default: every 1s or every 100 events, whichever first).
- Retries with exponential backoff on network errors and 5xx responses.
- Idempotency-key support so a retried batch doesn't double-fire.
- Graceful `shutdown()` so serverless processes don't lose buffered events.

Routing (which destinations get the event, what template formats it, retry policy on the outbound side) lives in the Hookwave dashboard, **not** in the SDK. That's deliberate — you change a destination without redeploying code.

## API

### `new Hookwave(options)`

```ts
new Hookwave({
  sourceKey: "src_live_…",      // required
  baseUrl: "https://ingest.hookwave.dev",  // default
  flushInterval: 1000,           // ms, default
  maxBatchSize: 100,             // events per batch, default
  maxRetries: 5,                 // per-batch, default
  requestTimeout: 30_000,        // ms, default
  onError: (err, events) => {},  // optional callback
  onFlush: (count) => {},        // optional callback
  onBeforeEmit: (type, payload) => payload, // optional PII scrubber; return null to drop
});
```

### `hw.emit(eventType, payload, options?)`

Fire-and-forget. Returns `void`. Buffers the event for the next flush.

```ts
hw.emit("order.created", { orderId: "o_abc", total: 4999 }, {
  idempotencyKey: "o_abc",
  occurredAt: new Date(),
  metadata: { traceId: "tr_xyz" },
  connection: "ops-alerts",     // hint a preferred connection slug
  correlationId: "req_789",
});
```

### `await hw.emitSync(eventType, payload, options?)`

Blocking variant — awaits delivery. Returns `{ eventId, status }`. Throws on failure. Use sparingly.

```ts
const { eventId } = await hw.emitSync("payment.failed", { orderId: "o_abc" });
```

### `await hw.flush()`

Force the buffer to flush now. Coalesces with any in-flight flush.

### `await hw.shutdown(timeoutMs?)`

Flushes the buffer and stops the auto-flush timer. **Call before process exit** in Lambda / Vercel / Cloudflare Workers. Default timeout: 30s.

```ts
process.on("SIGTERM", async () => {
  await hw.shutdown();
  process.exit(0);
});
```

## Serverless usage

In Lambda, Vercel, Cloudflare Workers, etc., the runtime freezes the process between invocations. Always `await hw.shutdown()` at the end of your handler so the buffer flushes:

```ts
export async function handler(event) {
  hw.emit("request.received", { path: event.path });
  try {
    return await doWork(event);
  } finally {
    await hw.shutdown();
  }
}
```

Or use `emitSync` so the call returns only after delivery succeeds.

## Security

- **Source keys are write-only.** They can only emit events into the source they're scoped to. If leaked, the blast radius is "an attacker can push events into one source" — limited by your per-source quota.
- Use `src_test_…` keys in development; events are tagged in the dashboard and excluded from billing.
- Never ship a source key in browser-facing code. (A browser-safe flow with short-lived tokens is on the roadmap.)

## Roadmap

- v0.2: TypeScript event-map generic, browser support (`sendBeacon`), framework helpers (Express / Fastify / Hono).
- v0.3: Python and Go SDKs sharing the same wire protocol.
- v1.0: Server-side schema registry, codegenerated types.

## License

MIT — see [LICENSE](./LICENSE).
