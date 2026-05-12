import type { Logger, LoggerOptions } from "./types.js"
import { LoggerImpl } from "./logger.js"
import type { Sink, SinkOptions } from "./sink.js"
import type { Level } from "./types.js"

/**
 * Options for the GCP Cloud Logging sink.
 *
 * Trade-off summary:
 *
 *   - labelKeys:  bounded keys (customer, environment) that should move
 *                 from jsonPayload to logging.googleapis.com/labels.
 *                 Labels are indexed by Cloud Logging for fast filtering;
 *                 keep total under 64 per entry.
 *
 *   - sourceLocation: parsing `new Error().stack` is expensive. Default
 *                 "error" only does it when level is error (matches the
 *                 Cloud Error Reporting use case). "always" parses every
 *                 log. "off" disables.
 */
export interface GcpSinkOptions extends SinkOptions {
  project?: string
  serviceName?: string
  serviceVersion?: string

  /**
   * Attribute keys that should be emitted under
   * `logging.googleapis.com/labels` instead of as flat `jsonPayload` fields.
   *
   * Cloud Logging indexes labels for fast filtering and they show as
   * chips in the UI. Cap at 64 per entry (GCP limit) — the sink will
   * warn-once and drop overflow.
   *
   * Use for low-cardinality bounded values like customer, environment,
   * service_plane. Do NOT use for unbounded values like request_id.
   */
  labelKeys?: string[]

  /**
   * Emit `logging.googleapis.com/sourceLocation` derived from a stack trace.
   *
   *   "error"  (default) — only emit on error-level logs. Cheap.
   *   "always"           — emit on every log. Slower; parses stack each call.
   *   "off"              — never emit.
   */
  sourceLocation?: "error" | "always" | "off"
}

interface GcpLogEntry {
  severity?: string
  message?: string
  timestamp?: string
  "logging.googleapis.com/trace"?: string
  "logging.googleapis.com/spanId"?: string
  "logging.googleapis.com/trace_sampled"?: boolean
  "logging.googleapis.com/operation"?: {
    id: string
    producer?: string
    first?: boolean
    last?: boolean
  }
  "logging.googleapis.com/labels"?: Record<string, string>
  "logging.googleapis.com/sourceLocation"?: {
    file: string
    line: string
    function: string
  }
  httpRequest?: {
    requestMethod?: string
    requestUrl?: string
    requestSize?: string
    status?: number
    responseSize?: string
    userAgent?: string
    remoteIp?: string
    serverIp?: string
    referer?: string
    latency?: string
    protocol?: string
  }
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

function resolveProject(opts?: GcpSinkOptions): string | undefined {
  return opts?.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT
}

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

function resolveServiceVersion(opts?: GcpSinkOptions): string {
  return (
    opts?.serviceVersion ??
    process.env.K_REVISION ??
    process.env.OTEL_SERVICE_VERSION ??
    process.env.npm_package_version ??
    "unknown"
  )
}

// Order of precedence inside the sink:
//   trace_id/span_id/trace_sampled → logging.googleapis.com/trace*
//   operation                     → logging.googleapis.com/operation
//   http_request                  → httpRequest
//   labelKeys-allowed keys        → logging.googleapis.com/labels
//   err / error (on error level)  → @type + stack_trace + serviceContext
//   everything else               → flat jsonPayload fields

// HTTP-request field names accepted in the `http_request` attr.
// All keys are optional; only the present ones are emitted.
const HTTP_REQUEST_FIELDS = [
  "requestMethod",
  "requestUrl",
  "requestSize",
  "status",
  "responseSize",
  "userAgent",
  "remoteIp",
  "serverIp",
  "referer",
  "latency",
  "protocol",
] as const

let labelOverflowWarned = false
function warnLabelOverflow(extras: number) {
  if (labelOverflowWarned) return
  labelOverflowWarned = true
  // eslint-disable-next-line no-console
  console.warn(
    `[@tetratelabs/logging] GCP labels exceed the 64-key limit (${extras} extra). ` +
      `Extra keys dropped from logging.googleapis.com/labels. Consider trimming labelKeys.`,
  )
}

interface StackFrame {
  file: string
  line: string
  function: string
}

/**
 * Best-effort parse of one frame from `new Error().stack`.
 *
 * V8-style:  "    at handlerFn (/abs/path/file.ts:42:13)"
 * Bare:      "    at /abs/path/file.ts:42:13"
 *
 * Skips frames inside this library so we report the caller's location.
 */
function parseCallerFrame(stack: string | undefined): StackFrame | undefined {
  if (!stack) return undefined
  const lines = stack.split("\n")
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith("at ")) continue
    // Skip frames inside this library.
    if (line.includes("@tetratelabs/logging/") || line.includes("/logging-node/dist/")) {
      continue
    }
    // Match "at fnName (file:line:col)" or "at file:line:col".
    const withFn = /at\s+(\S+)\s+\((.+):(\d+):\d+\)$/.exec(line)
    if (withFn) {
      return {
        function: withFn[1]!,
        file: withFn[2]!,
        line: withFn[3]!,
      }
    }
    const bare = /at\s+(.+):(\d+):\d+$/.exec(line)
    if (bare) {
      return { function: "<anonymous>", file: bare[1]!, line: bare[2]! }
    }
  }
  return undefined
}

/**
 * Creates a GCP Cloud Logging-compatible sink.
 */
export function createGcpSink(opts?: GcpSinkOptions): Sink {
  const project = resolveProject(opts)
  const serviceName = resolveServiceName(opts)
  const serviceVersion = resolveServiceVersion(opts)
  const labelKeys = new Set(opts?.labelKeys ?? [])
  const sourceLocationMode = opts?.sourceLocation ?? "error"

  return {
    write(level: Level, msg: string, fields: Record<string, unknown>) {
      const entry: GcpLogEntry = {
        severity: pinoLevelToGcpSeverity(level),
        message: msg,
        timestamp: new Date().toISOString(),
      }

      const remaining = { ...fields }

      // Trace correlation.
      if (project && remaining.trace_id) {
        const traceId = String(remaining.trace_id)
        delete remaining.trace_id
        entry["logging.googleapis.com/trace"] = `projects/${project}/traces/${traceId}`

        if (remaining.span_id) {
          entry["logging.googleapis.com/spanId"] = String(remaining.span_id)
          delete remaining.span_id
        }
        if (typeof remaining.trace_sampled === "boolean") {
          entry["logging.googleapis.com/trace_sampled"] = remaining.trace_sampled
          delete remaining.trace_sampled
        }
      } else {
        // Strip trace fields even if we cannot rewrite them; they were
        // not requested by the caller as plain fields.
        delete remaining.trace_id
        delete remaining.span_id
        delete remaining.trace_sampled
      }

      // logging.googleapis.com/operation.
      if (remaining.operation && typeof remaining.operation === "object") {
        const op = remaining.operation as {
          id?: unknown
          producer?: unknown
          first?: unknown
          last?: unknown
        }
        if (typeof op.id === "string") {
          const out: GcpLogEntry["logging.googleapis.com/operation"] = { id: op.id }
          if (typeof op.producer === "string") out.producer = op.producer
          if (op.first === true) out.first = true
          if (op.last === true) out.last = true
          entry["logging.googleapis.com/operation"] = out
        }
        delete remaining.operation
      }

      // httpRequest.
      if (remaining.http_request && typeof remaining.http_request === "object") {
        const src = remaining.http_request as Record<string, unknown>
        const out: NonNullable<GcpLogEntry["httpRequest"]> = {}
        for (const key of HTTP_REQUEST_FIELDS) {
          const v = src[key]
          if (v == null) continue
          if (key === "status") {
            const n = Number(v)
            if (Number.isFinite(n)) out.status = n
          } else {
            out[key] = String(v) as never
          }
        }
        if (Object.keys(out).length > 0) entry.httpRequest = out
        delete remaining.http_request
      }

      // Error Reporting payload (level === error and `err` present).
      if (level === "error" && (remaining.err || remaining.error)) {
        const err = (remaining.err ?? remaining.error) as {
          stack?: string
          message?: string
          name?: string
        }
        delete remaining.err
        delete remaining.error
        entry["@type"] =
          "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"
        if (err.stack) {
          entry.stack_trace = err.stack
        } else if (err.message) {
          entry.stack_trace = `${err.name || "Error"}: ${err.message}`
        }
        entry.serviceContext = { service: serviceName, version: serviceVersion }
      }

      // Labels routing.
      if (labelKeys.size > 0) {
        const labels: Record<string, string> = {}
        let overflow = 0
        for (const key of Array.from(labelKeys)) {
          if (remaining[key] == null) continue
          const value = remaining[key]
          delete remaining[key]
          if (Object.keys(labels).length >= 64) {
            overflow++
            continue
          }
          labels[key] = String(value)
        }
        if (Object.keys(labels).length > 0) {
          entry["logging.googleapis.com/labels"] = labels
        }
        if (overflow > 0) warnLabelOverflow(overflow)
      }

      // sourceLocation. Parse stack only when the policy allows.
      const wantLoc =
        sourceLocationMode === "always" || (sourceLocationMode === "error" && level === "error")
      if (wantLoc) {
        const frame = parseCallerFrame(new Error().stack)
        if (frame) {
          entry["logging.googleapis.com/sourceLocation"] = frame
        }
      }

      // Anything left lands as flat jsonPayload.
      Object.assign(entry, remaining)

      // eslint-disable-next-line no-console
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
