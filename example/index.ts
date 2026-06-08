/**
 * Minimal Hookwave SDK example.
 *
 * Run from the package root:
 *   npm run example
 *
 * That boots a tiny local mock of the Hookwave ingest endpoint, then
 * runs this script against it so you can see real network requests,
 * batching, retries, and the shutdown flush — without needing a real
 * Hookwave account or source key.
 *
 * In production, drop `baseUrl` and use a real `src_live_…` key.
 */

import { Hookwave } from "../src/index.js";

const hw = new Hookwave({
  sourceKey: process.env.HOOKWAVE_SOURCE_KEY ?? "src_test_examplekeyXXXXXXXXXX",
  // Point at the local mock during development. In production, omit
  // this — it defaults to https://ingest.hookwave.dev.
  baseUrl: process.env.HOOKWAVE_BASE_URL ?? "http://127.0.0.1:4400",
  onFlush: (count) => console.log(`✓ flushed ${count} event(s)`),
  onError: (err) => console.error("✗ flush failed:", err.message),
});

async function main() {
  console.log("→ emit user.signed_up");
  hw.emit("user.signed_up", {
    userId: "u_123",
    email: "ruben@hookwave.dev",
    plan: "pro",
  });

  console.log("→ emit order.created (with idempotency key)");
  hw.emit(
    "order.created",
    { orderId: "o_abc", total: 4999 },
    { idempotencyKey: "o_abc" },
  );

  console.log("→ emit page.viewed (with metadata + correlation)");
  hw.emit(
    "page.viewed",
    { path: "/dashboard", referrer: "/login" },
    {
      metadata: { traceId: "tr_xyz" },
      correlationId: "req_789",
    },
  );

  // Blocking variant — awaits delivery and returns the eventId.
  console.log("→ emitSync payment.failed (awaits response)");
  const result = await hw.emitSync("payment.failed", {
    orderId: "o_abc",
    reason: "card_declined",
  });
  console.log(`  got eventId=${result.eventId} status=${result.status}`);

  // In a real app, call shutdown() before process exit (Lambda,
  // Vercel, etc.) so the buffer flushes.
  console.log("→ shutdown");
  await hw.shutdown();
  console.log("✓ done");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
