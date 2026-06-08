# Example — `@hookwave/sdk`

A 50-line script that emits a handful of events using the SDK. A tiny local mock of the Hookwave ingest endpoint runs alongside so you can see real requests, batching, and retries — no Hookwave account required.

## Run it

From the package root (one directory up):

```sh
npm run example
```

You'll see something like:

```
[mock] listening on http://127.0.0.1:4400
→ emit user.signed_up
→ emit order.created (with idempotency key)
→ emit page.viewed (with metadata + correlation)
→ emitSync payment.failed (awaits response)

[mock] batch #1 — 1 event(s) (total: 1)
         {"type":"payment.failed","payload":{"orderId":"o_abc","reason":"card_declined"}}
  got eventId=… status=accepted
→ shutdown

[mock] batch #2 — 3 event(s) (total: 4)
         {"type":"user.signed_up", …}
         {"type":"order.created", …}
         {"type":"page.viewed", …}
✓ flushed 3 event(s)
✓ done
```

Notice:

- **Batching** — the three fire-and-forget `emit` calls land as **one batch**, not three requests.
- **`emitSync` bypasses the buffer** — it sends its own immediate request and awaits the response.
- **Shutdown flushes** — the final `await hw.shutdown()` is what gets the three buffered events out the door.

## Use against a real Hookwave source

Drop the mock and point at production:

```ts
const hw = new Hookwave({
  sourceKey: process.env.HOOKWAVE_SOURCE_KEY!,
  // (no baseUrl — defaults to https://ingest.hookwave.dev)
});
```

Generate a source key in the dashboard at [hookwave.dev/dashboard/sources](https://hookwave.dev/dashboard/sources) → pick a source → **Generate SDK key**.
