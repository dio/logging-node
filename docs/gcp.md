# GCP / Cloud Logging adapter

The `@tetratelabs/logging/gcp` subpath emits logs in [Cloud Logging structured JSON format](https://cloud.google.com/logging/docs/structured-logging), with severity buckets, trace correlation, Error Reporting payloads, and the UI features Cloud Logging surfaces from structured fields.

## Minimal wiring

```ts
import { createGcpLogger, setGlobalLogger } from "@tetratelabs/logging/gcp"

setGlobalLogger(
  createGcpLogger({
    name: "myservice",
    level: process.env.LOG_LEVEL ?? "info",
    project: process.env.GOOGLE_CLOUD_PROJECT,
  }),
)
```

`project` is required for `logging.googleapis.com/trace` correlation. Without it the sink still produces valid Cloud Logging JSON, just without trace links.

## What it does

- Maps levels to GCP severity (`DEBUG`, `INFO`, `WARNING`, `ERROR`) so the Cloud Logging UI buckets them correctly
- Renames `msg` to `message` and emits an ISO-8601 `timestamp` per the [LogEntry spec](https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry)
- When `project` is set and a trace is active, rewrites `trace_id`/`span_id` into `logging.googleapis.com/trace`, `spanId`, and `trace_sampled`
- On `log.error({ err }, msg)`, emits the [Cloud Error Reporting](https://cloud.google.com/error-reporting/docs/formatting-error-messages) payload (`@type`, `stack_trace`, `serviceContext`) so errors show up in the Error Reporting console
- Falls back to `K_SERVICE` / `K_REVISION` env when `serviceName`/`serviceVersion` are not passed (Cloud Run sets these automatically)

## Default value resolution

Project (for trace correlation):

1. `opts.project`
2. `GOOGLE_CLOUD_PROJECT` (App Engine, Cloud Functions, gcloud CLI)
3. `GCLOUD_PROJECT` (legacy)

Service name (for Error Reporting):

1. `opts.serviceName`
2. `K_SERVICE` (Cloud Run, automatic)
3. `OTEL_SERVICE_NAME`
4. `opts.name` (the logger's own name)
5. `npm_package_name`
6. `"unknown"`

Service version:

1. `opts.serviceVersion`
2. `K_REVISION` (Cloud Run, automatic)
3. `OTEL_SERVICE_VERSION`
4. `npm_package_version`
5. `"unknown"`

## Structured fields (v0.3.0)

Beyond severity and trace correlation, the GCP sink emits four optional structured fields that unlock specific Cloud Logging UI features.

### `httpRequest`

Adds Method, URL, Status, Latency columns to the Cloud Logging UI and enables filtering chips. The Hono middleware emits this on every request summary log line. No config needed.

```jsonc
{
  "severity": "INFO",
  "message": "request handled",
  "httpRequest": {
    "requestMethod": "GET",
    "requestUrl": "/api/echo",
    "status": 200,
    "latency": "0.045s",
    "userAgent": "curl/8",
    "remoteIp": "203.0.113.1",
  },
}
```

To disable: `loggingMiddleware({ httpRequest: false })`.

### `logging.googleapis.com/operation`

Groups all log lines from a single request under one expandable entry in the Cloud Logging UI. The Hono middleware:

- Emits a "request received" log with `first: true` at request start
- Stamps `{ id, producer }` on every log inside the request scope
- Emits a "request handled" log with `last: true` at request end

```ts
app.use(loggingMiddleware({ operation: { producer: "auth" } }))
// producer defaults to OTEL_SERVICE_NAME when not set explicitly
// To disable: operation: false
```

### `logging.googleapis.com/labels`

Moves bounded keys from `jsonPayload` to indexed labels for fast Cloud Logging filtering. Cap is 64 per entry. Use for low-cardinality values like customer, environment, region.

```ts
createGcpLogger({
  name: "auth",
  labelKeys: ["customer", "environment", "service_plane"],
})
// Any log with attrs { customer: "acme", ... } emits:
//   "logging.googleapis.com/labels": { "customer": "acme", ... }
// instead of flat jsonPayload fields.
```

NEVER put unbounded keys here (request_id, user_id). Cloud Logging will still index them and bill you, and overflow past 64 keys triggers a one-time warn.

### `logging.googleapis.com/sourceLocation`

Emits `{ file, line, function }` for the call site, used by Cloud Error Reporting for grouping.

```ts
createGcpLogger({ sourceLocation: "error" }) // default: only on error level
createGcpLogger({ sourceLocation: "always" }) // every log (parses stack each call)
createGcpLogger({ sourceLocation: "off" }) // never
```

Parsing `new Error().stack` is not free. The `"error"` default keeps it cheap by only doing it on the level where Error Reporting cares.

### `logging.googleapis.com/trace_sampled`

Derived from the active OTel `SpanContext.traceFlags`. No config needed. Previously hard-coded to `true`; v0.3.0 reflects reality so tail-sampled traces are correctly marked.

## Deployment

### Cloud Run

Cloud Run injects `K_SERVICE` and `K_REVISION` automatically, so this works with no config beyond the project:

```ts
setGlobalLogger(createGcpLogger({ project: process.env.GOOGLE_CLOUD_PROJECT }))
```

Or if you set `GOOGLE_CLOUD_PROJECT` in the service env:

```ts
setGlobalLogger(createGcpLogger())
```

### GKE

On GKE, set the OpenTelemetry env vars in your Deployment via the Downward API. The logger picks them up automatically and they also feed the OTel SDK, so service name stays consistent across logs, traces, and metrics.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fraser-auth
  labels:
    app.kubernetes.io/name: fraser-auth
    app.kubernetes.io/version: "1.2.3"
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: fraser-auth
        app.kubernetes.io/version: "1.2.3"
    spec:
      containers:
        - name: app
          image: gcr.io/my-project/fraser-auth:1.2.3
          env:
            - name: OTEL_SERVICE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: "metadata.labels['app.kubernetes.io/name']"
            - name: OTEL_SERVICE_VERSION
              valueFrom:
                fieldRef:
                  fieldPath: "metadata.labels['app.kubernetes.io/version']"
            - name: GOOGLE_CLOUD_PROJECT
              value: "my-gcp-project"
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: POD_NAMESPACE
              valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
```

Code side:

```ts
import { createGcpLogger, setGlobalLogger } from "@tetratelabs/logging/gcp"

setGlobalLogger(createGcpLogger()) // zero config
```

Cloud Logging's GKE log scraper auto-tags entries with `resource.type: k8s_container` and adds pod/namespace/cluster labels at ingestion. You don't need to emit those yourself.

## Known limitations

GCP metadata server project auto-detection is not yet implemented. Coming in the next PR. v0.3.x requires `GOOGLE_CLOUD_PROJECT` env (or explicit `project` option). Cloud Run sets this automatically; on GKE wire it through the Downward API.
