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
 * Creates a GCP Cloud Logging-compatible sink.
 * Transforms standard log entries to GCP format with proper severity mapping,
 * trace correlation support, and error reporting integration.
 */
export function createGcpSink(opts?: GcpSinkOptions): Sink {
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
      if (opts?.project && fieldsCopy.trace_id) {
        const traceId = String(fieldsCopy.trace_id)
        delete fieldsCopy.trace_id
        entry["logging.googleapis.com/trace"] = `projects/${opts.project}/traces/${traceId}`

        if (fieldsCopy.span_id) {
          const spanId = String(fieldsCopy.span_id)
          delete fieldsCopy.span_id
          entry["logging.googleapis.com/spanId"] = spanId
          entry["logging.googleapis.com/trace_sampled"] = true
        }
      }

      // Handle error reporting for ERROR and CRITICAL severity
      if (level === "error" && fieldsCopy.err) {
        const err = fieldsCopy.err as any
        delete fieldsCopy.err

        entry["@type"] =
          "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"

        // Build stack trace in GCP format: "Error: message\n    at ..."
        if (err.stack) {
          entry.stack_trace = err.stack
        } else if (err.message) {
          entry.stack_trace = `${err.name || "Error"}: ${err.message}`
        }

        // Service context for error reporting
        entry.serviceContext = {
          service: opts?.serviceName ?? process.env.K_SERVICE ?? "unknown",
          version: opts?.serviceVersion ?? process.env.K_REVISION ?? "unknown",
        }
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
