/**
 * Deterministic load fixture for the serialized Node→Python bridge queue.
 *
 * This does not emulate KiCad business logic. It drives the real compiled
 * KiCADMcpServer queue with a fixed-delay fake Python stdin/stdout boundary so
 * queue bounds and latency instrumentation can be measured without native
 * pcbnew. Native acceptance is a separate Windows/KiCad lane.
 */

import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "../dist/server.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));
const concurrencyLevels = [1, 2, 4, 8, 16];
const serviceMs = positiveInt(process.env.KICAD_QUEUE_FIXTURE_SERVICE_MS, 8);
const maxQueueDepth = positiveInt(process.env.KICAD_QUEUE_FIXTURE_MAX_DEPTH, 32);
const enqueueDeadlineMs = positiveInt(process.env.KICAD_QUEUE_FIXTURE_DEADLINE_MS, 5_000);

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

async function runLevel(concurrency) {
  const metrics = [];
  const server = new KiCADMcpServer(pythonBridge, "error", {
    maxQueueDepth,
    enqueueDeadlineMs,
    metricsSink: (metric) => metrics.push(metric),
  });

  const baselineHeap = process.memoryUsage().heapUsed;
  let peakHeap = baselineHeap;
  const sampleMemory = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 1);

  server.pythonProcess = {
    stdin: {
      write(line) {
        const request = JSON.parse(String(line));
        setTimeout(() => {
          server.handlePythonResponse(
            Buffer.from(
              JSON.stringify({
                success: true,
                fixture: true,
                _requestId: request.requestId,
              }) + "\n",
            ),
          );
        }, serviceMs);
        return true;
      },
    },
  };
  server.readyDetected = true;

  const calls = Array.from({ length: concurrency }, (_, index) =>
    server.callKicadScript(`fixture_${index + 1}`, {}),
  );
  const settled = await Promise.allSettled(calls);

  clearInterval(sampleMemory);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);

  const snapshot = server.getBridgeRuntimeMetrics();
  const completed = metrics.filter((metric) => metric.event === "completed");
  const totalLatencies = completed.map((metric) => metric.total_latency_ms);
  const queueWaits = completed.map((metric) => metric.queue_wait_ms);
  const rejected = settled.filter((result) => result.status === "rejected").length;
  const total = settled.length;

  return {
    concurrency,
    service_ms: serviceMs,
    p50_total_latency_ms: percentile(totalLatencies, 0.5),
    p95_total_latency_ms: percentile(totalLatencies, 0.95),
    p50_queue_wait_ms: percentile(queueWaits, 0.5),
    p95_queue_wait_ms: percentile(queueWaits, 0.95),
    peak_heap_delta_kib: Math.max(0, Math.round((peakHeap - baselineHeap) / 1024)),
    error_rate_pct: total === 0 ? 0 : Number(((rejected / total) * 100).toFixed(2)),
    timeout_rate_pct:
      total === 0 ? 0 : Number(((snapshot.timeout_count / total) * 100).toFixed(2)),
    max_queue_depth_observed: Math.max(0, ...metrics.map((metric) => metric.queue_depth)),
    timeout_count: snapshot.timeout_count,
    error_count: snapshot.error_count,
    rejection_count: snapshot.rejection_count,
  };
}

const rows = [];
for (const concurrency of concurrencyLevels) {
  rows.push(await runLevel(concurrency));
}

console.log(
  "| callers | p50 total ms | p95 total ms | p50 queue ms | p95 queue ms | peak heap KiB | error % | timeout % |",
);
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of rows) {
  console.log(
    `| ${row.concurrency} | ${row.p50_total_latency_ms} | ${row.p95_total_latency_ms} | ${row.p50_queue_wait_ms} | ${row.p95_queue_wait_ms} | ${row.peak_heap_delta_kib} | ${row.error_rate_pct.toFixed(2)} | ${row.timeout_rate_pct.toFixed(2)} |`,
  );
}
console.log("\nJSON:");
console.log(JSON.stringify({ fixture: "serialized-bridge-fixed-load-v1", rows }, null, 2));

if (rows.some((row) => row.timeout_count !== 0 || row.rejection_count !== 0 || row.error_count !== 0)) {
  process.exitCode = 1;
}
