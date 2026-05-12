import type { Logger, LoggerOptions } from "./types.js"
import { LoggerImpl } from "./logger.js"
import type { Sink, SinkOptions } from "./sink.js"
import type { Level } from "./types.js"

interface GcpSinkOptions extends SinkOptions {
  project?: string
  serviceName?: string
  serviceVersion?: string
}

interface GcpLogEntry {
  severity?: string
  message?: string
  timestamp?: string
  "logging.googleapis.com/trace"?: string
  "logging.googleapis.com/spanId"?: string
  "logging.googleapis.com/trace_sampled"?: boolean
  "@type"?: string
  stack_trace?: string
  serviceContext?: {
    service: string
    version: string
  }
  [key: string]: unknown
}

/**
 * Maps pino numeric levels to GCP severity strings
 * https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#severity
 */
function pinoLevelToGcpSeverity(level: Level): string {
  switch (level) {
    case "debug":
      return "DEBUG"
    case "info":
      return "INFO"
    case "warn":
      return "WARNING"
    case "error":
      return "ERROR"
    case "none":
      return "DEFAULT"
    default:
      return "DEFAULT"
  }
}

/**
 * Resolve the GCP project ID from (in order):
 *   1. explicit opts.project
 *   2. GOOGLE_CLOUD_PROJECT  (App Engine, Cloud Functions, gcloud CLI)
 *   3. GCLOUD_PROJECT        (legacy, still set by some tooling)
 *
 * Returns undefined if none are set, in which case the sink skips
 * trace-correlation rewrites (the logs are still valid Cloud Logging JSON,
 * they just won't link to Cloud Trace).
 *
 * Auto-detection from the GCP metadata server (Cloud Run, GKE, GCE) is
 * deliberately out of scope for v0.2.x — it requires an async network
 * call on init and complicates the sync sink. Set GOOGLE_CLOUD_PROJECT
 * explicitly in your deployment manifest.
 */
function resolveProject(opts?: GcpSinkOptions): string | undefined {
  return opts?.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT
}

/**
 * Resolve service name for Cloud Error Reporting. Fallback chain:
 *   1. opts.serviceName       — explicit override
 *   2. K_SERVICE              — Cloud Run, automatic
 *   3. OTEL_SERVICE_NAME      — OpenTelemetry convention
 *   4. opts.name              — the logger's own name (sensible default)
 *   5. npm_package_name       — populated by npm / bun when running scripts
 *   6. "unknown"
 */
function resolveServiceName(opts?: GcpSinkOptions): string {
  return (
    opts?.serviceName ??
    process.env.K_SERVICE ??
    process.env.OTEL_SERVICE_NAME ??
    opts?.name ??
    process.env.npm_package_name ??
    "unknown"
  )
}

/**
 * Resolve service version for Cloud Error Reporting. Fallback chain:
 *   1. opts.serviceVersion    — explicit override
 *   2. K_REVISION             — Cloud Run, automatic
 *   3. OTEL_SERVICE_VERSION   — OpenTelemetry convention
 *   4. npm_package_version    — populated by npm / bun when running scripts
 *   5. "unknown"
 */
function resolveServiceVersion(opts?: GcpSinkOptions): string {
  return (
    opts?.serviceVersion ??
    process.env.K_REVISION ??
    process.env.OTEL_SERVICE_VERSION ??
    process.env.npm_package_version ??
    "unknown"
  )
}

/**
 * Creates a GCP Cloud Logging-compatible sink.
 * Transforms standard log entries to GCP format with proper severity mapping,
 * trace correlation support, and error reporting integration.
 */
export function createGcpSink(opts?: GcpSinkOptions): Sink {
  const project = resolveProject(opts)
  const serviceName = resolveServiceName(opts)
  const serviceVersion = resolveServiceVersion(opts)

  return {
    write(level: Level, msg: string, fields: Record<string, unknown>) {
      const entry: GcpLogEntry = {
        severity: pinoLevelToGcpSeverity(level),
        message: msg,
        timestamp: new Date().toISOString(),
      }

      // Copy all fields into the entry, handling special cases
      const fieldsCopy = { ...fields }

      // Handle trace correlation: GCP conventions
      if (project && fieldsCopy.trace_id) {
        const traceId = String(fieldsCopy.trace_id)
        delete fieldsCopy.trace_id
        entry["logging.googleapis.com/trace"] = `projects/${project}/traces/${traceId}`

        if (fieldsCopy.span_id) {
          const spanId = String(fieldsCopy.span_id)
          delete fieldsCopy.span_id
          entry["logging.googleapis.com/spanId"] = spanId
          entry["logging.googleapis.com/trace_sampled"] = true
        }
      }

      // Handle error reporting for ERROR severity
      if (level === "error" && fieldsCopy.err) {
        const err = fieldsCopy.err as any
        delete fieldsCopy.err

        entry["@type"] =
          "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"

        // Build stack trace in GCP format
        if (err.stack) {
          entry.stack_trace = err.stack
        } else if (err.message) {
          entry.stack_trace = `${err.name || "Error"}: ${err.message}`
        }

        entry.serviceContext = { service: serviceName, version: serviceVersion }
      }

      // Merge remaining fields
      Object.assign(entry, fieldsCopy)

      console.log(JSON.stringify(entry))
    },
  }
}

/**
 * Creates a logger with GCP Cloud Logging sink.
 */
export function createGcpLogger(opts?: GcpSinkOptions & LoggerOptions): Logger {
  const sink = createGcpSink(opts)
  return new LoggerImpl(sink, opts)
}
