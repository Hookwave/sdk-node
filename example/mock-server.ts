/**
 * Tiny mock of `POST /v1/ingest/batch` so the example can run end-to-end
 * without a real Hookwave account. Boots on http://127.0.0.1:4400, logs
 * every received batch, exits cleanly when the example calls shutdown.
 *
 * Not for production use — no auth, no dedup, no rate limit. Just enough
 * to validate the SDK's wire shape + batching + retry behaviour.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4400);
let totalEvents = 0;
let totalBatches = 0;

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/ingest/batch") {
    res.writeHead(404).end();
    return;
  }

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer src_")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing or invalid source key" }));
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body) as { events: unknown[] };
      const count = parsed.events?.length ?? 0;
      totalBatches += 1;
      totalEvents += count;

      console.log(
        `\n[mock] batch #${totalBatches} — ${count} event(s) (total: ${totalEvents})`,
      );
      for (const e of parsed.events) {
        console.log("        ", JSON.stringify(e));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: count, rejected: [] }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}`);
});

// Auto-exit after 10s of no requests so the example script can run
// the full mock+client flow with a single `npm run example` command.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(
      `\n[mock] idle — shutting down (received ${totalEvents} event(s) across ${totalBatches} batch(es))`,
    );
    server.close(() => process.exit(0));
  }, 3_000);
}
server.on("request", resetIdle);
resetIdle();
