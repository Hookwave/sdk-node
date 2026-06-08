import type { BatchRequest, BatchResponse } from "./types.js";

/**
 * Tiny HTTP layer. Native fetch (Node 18+), AbortController for
 * per-request timeouts, exponential backoff for retries on transient
 * failures (network errors + 408 / 429 / 5xx). 4xx errors are
 * permanent — surfaced immediately.
 */

export interface SendBatchArgs {
  baseUrl: string;
  sourceKey: string;
  body: BatchRequest;
  requestTimeout: number;
  maxRetries: number;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function sendBatch(args: SendBatchArgs): Promise<BatchResponse> {
  const url = `${args.baseUrl.replace(/\/$/, "")}/v1/ingest/batch`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with full jitter — 1s, 2s, 4s, 8s, … capped at 30s.
      const baseDelay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const delay = Math.random() * baseDelay;
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.requestTimeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.sourceKey}`,
          "User-Agent": "hookwave-sdk-node/0.1.0",
        },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as BatchResponse;
      }

      const text = await response.text().catch(() => "");
      const err = new Error(
        `Hookwave ingest ${response.status}: ${text || response.statusText}`,
      );

      // Permanent failure — bail without further retries.
      if (!RETRYABLE_STATUSES.has(response.status)) throw err;

      lastError = err;
    } catch (err) {
      // Bail on permanent / programmer errors (bad URL, JSON encode failure).
      // AbortError on timeout is retryable.
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(
          `Hookwave ingest timed out after ${args.requestTimeout}ms`,
        );
      } else if (
        err instanceof Error &&
        err.message.startsWith("Hookwave ingest")
      ) {
        // Already-formatted non-retryable error from above.
        throw err;
      } else {
        lastError = err as Error;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Hookwave ingest failed for unknown reason");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
