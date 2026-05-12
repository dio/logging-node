# @tetratelabs/logging

Structured logging with guaranteed metrics. A Node port of [dio/logging](https://github.com/dio/logging) (Go).

## Features

- **Metrics fire even when logs are silenced** — the core guarantee
- **Built on [pino](https://getpino.io)** — fast, JSON-native structured logging
- **OpenTelemetry Context integration** — automatic trace correlation, no explicit ctx threading
- **Next.js first-class** — works on both Node and Edge runtimes
- **TypeScript-first** — full type safety

## Install

```sh
pnpm add @tetratelabs/logging pino
npm install @tetratelabs/logging pino
yarn add @tetratelabs/logging pino
```

## Quick start

```ts
import { createLogger, log, withAttrs } from "@tetratelabs/logging"
import { metrics } from "@opentelemetry/api"

// Create a logger (or use the global singleton)
const logger = createLogger({ name: "myapp", level: "info" })

// Structured logging (pino-style: attrs first, message second)
logger.info({ user_id: "123", provider: "google" }, "user signin")

// With metrics (fires before level check)
const requests = metrics.getMeter("myapp").createCounter("requests_total")
logger.metric(requests).info("handled")

// Context-scoped attributes (flows to logs + metrics)
await withAttrs({ request_id: req.id }, async () => {
  logger.info("processing") // includes request_id
})

// Or use the global singleton
import { log } from "@tetratelabs/logging"
log.info("quick message")
```

## Next.js setup

### 1. `next.config.js`

Mark pino and this package as external to avoid bundling issues:

```js
module.exports = {
  serverExternalPackages: ["@tetratelabs/logging", "pino", "thread-stream"],
}
```

### 2. `instrumentation.ts` (root)

Wire OTel and the logger at server boot:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerOTel } = await import("@vercel/otel")
    registerOTel({ serviceName: "myapp" })

    const { createLogger, setGlobalLogger } = await import("@tetratelabs/logging")
    setGlobalLogger(createLogger({ name: "myapp", level: process.env.LOG_LEVEL ?? "info" }))
  }
}
```

### 3. Use anywhere

In route handlers, server actions, or RSCs:

```ts
import { withAttrs, log } from "@tetratelabs/logging"

export default async function Page({ params }: { params: { id: string } }) {
  return await withAttrs({ request_id: params.id }, async () => {
    log.info("loading page")
    return <Content />
  })
}
```

## API

### `createLogger(options?)`

```ts
interface LoggerOptions {
  name?: string
  level?: "debug" | "info" | "warn" | "error" | "none"
  pino?: PinoOptions // Node runtime only
}
```

### Logger methods

```ts
logger.debug(msg, attrs?)
logger.info(msg, attrs?)
logger.warn(msg, attrs?)
logger.error(msg, err, attrs?)

// Structured building
logger.with(attrs)        // returns a child logger with persistent attributes
logger.context(ctx)       // use explicit OTel Context (instead of active)
logger.metric(counter)    // attach a metric to fire before level check
logger.setLevel(level)    // runtime adjustment
logger.level()            // get current level
```

### `withAttrs(attrs, fn)`

Scopes **metric-safe** (bounded) attributes to an async function. These appear on log records AND on counter labels for every `log.metric(c).info(...)` inside.

```ts
await withAttrs({ customer_id: "acme" }, async () => {
  logger.info("order placed") // log line has customer_id
  log.metric(orders).info("order placed") // counter labelled customer_id="acme"
})
```

Use for **bounded** values only: customer ID (capped at <100), region, environment, plan tier, role enum. Anything where the value space is small and known.

### `withLogAttrs(attrs, fn)` ← added in v0.3.0

Scopes **log-only** (unbounded) attributes to an async function. These appear on log records but are **never** attached to counter labels.

```ts
await withLogAttrs({ request_id: "abc", user_id: "u-123" }, async () => {
  logger.info("processing") // log line has request_id and user_id
  log.metric(orders).info("processing") // counter NOT labelled by request_id
})
```

Use for **unbounded** values: `request_id`, `user_id`, `email`, `ip`, `user_agent`, raw paths, raw query strings. Anything where the value space is huge or unknown.

### Why two scopes?

OpenTelemetry counters create a new time series for every unique combination of label values. If `request_id` ends up as a counter label, every request creates a new series. A service doing 1k RPS for an hour gets 3.6 million series. Counters become useless and your metrics backend bills you for the storage.

The fix is keeping unbounded values strictly off counters. Two scopes encode this in the API so it cannot be done by accident.

| Function              | Goes on logs? | Goes on metrics? | When to use                                   |
| --------------------- | ------------- | ---------------- | --------------------------------------------- |
| `withAttrs`           | yes           | yes              | bounded enums: customer, region, env, role    |
| `withLogAttrs`        | yes           | no               | unbounded: request_id, user_id, ip, raw paths |
| call-site `attrs` arg | yes           | yes              | per-call labels (must also be bounded)        |

### Anti-pattern (this used to ship)

```ts
// WRONG — request_id leaks to every counter label as a cardinality bomb.
await withAttrs({ request_id, customer_id }, async () => {
  log.metric(orders).info("order placed")
})
```

```ts
// RIGHT — bounded labels and unbounded fields kept separate.
await withAttrs({ customer_id }, async () => {
  await withLogAttrs({ request_id }, async () => {
    log.metric(orders).info("order placed")
  })
})
```

The Hono middleware (`@tetratelabs/logging/hono`) handles this split automatically. See the Hono section below.

## When to use what

The library gives you three ways to attach attributes. Pick deliberately — `withAttrs` is the most powerful but also the most intrusive.

| You want…                                                                        | Use                            | Example                                                     |
| -------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Attach attrs to **one log line**                                                 | per-call `attrs` arg           | `log.info({ user_id }, "ok")`                               |
| Attach attrs to **many calls in the same function**                              | `log.with(...)` (child logger) | `const reqLog = log.with({ request_id }); reqLog.info(...)` |
| Attach attrs to **everything downstream**, including async fns you don't control | `withAttrs(...)`               | middleware sets `request_id`, every nested log inherits it  |

### Rule of thumb

> **Use `withAttrs` only at boundaries** — middleware, route handlers, the top of a request — where you set request-scoped attrs (`request_id`, `tenant`, `user_id`) **once**. Everywhere else, prefer plain `log.info(msg, attrs)` or `log.with(attrs)`.

In practice this means **your business code almost never writes `withAttrs` directly**. The Hono middleware (`@tetratelabs/logging/hono`) wraps the chain for you; in Next.js you write it once per request boundary.

### Why `withAttrs` is intrusive

It's worth knowing what you're trading for the convenience:

1. **Indents your code.** Your function body lives inside a callback. Early returns and top-level `return` become more awkward.
2. **Async-only contract.** Works because OTel Context propagates through `await`. If you spawn a worker thread or pass a callback to a queue that runs outside the request's async tree, attrs are lost.
3. **Small but real overhead.** AsyncLocalStorage adds ~50–200 ns per `await`. Negligible for HTTP services; measurable in hot loops doing 100k+ awaits/sec.
4. **Hidden control flow.** A log line in `loadUser` mysteriously has `tenant=acme` attached. Great for ops, surprising for new readers.

### When to skip `withAttrs` entirely

```ts
// ❌ Overkill — the attr is only used once.
await withAttrs({ user_id }, async () => {
  log.info("user fetched")
})

// ✅ Just pass it directly.
log.info({ user_id }, "user fetched")

// ❌ Overkill — used in one function, no nested awaits that need it.
async function loadUser(id: string) {
  return await withAttrs({ user_id: id }, async () => {
    const row = await db.users.find(id)
    log.info({ row_count: row ? 1 : 0 }, "loaded")
    return row
  })
}

// ✅ Child logger does the job with less ceremony.
async function loadUser(id: string) {
  const reqLog = log.with({ user_id: id })
  const row = await db.users.find(id)
  reqLog.info({ row_count: row ? 1 : 0 }, "loaded")
  return row
}
```

### When `withAttrs` earns its keep

```ts
// Middleware sets request-scoped attrs ONCE.
app.use(async (c, next) => {
  await withAttrs(
    {
      request_id: c.req.header("x-request-id") ?? crypto.randomUUID(),
      tenant: c.req.header("x-tenant") ?? "default",
    },
    () => next(),
  )
})

// 20 layers down, in a util you didn't write,
// this log line automatically has request_id + tenant attached.
// Same for any metric .add() call inside.
log.info("cache miss")
```

This is the only pattern where the indentation cost is paid by _one_ file (the middleware) and _zero_ business code.

### Already covered for you

You get this for free, without writing `withAttrs` yourself:

- **Hono**: `app.use(loggingMiddleware())` from `@tetratelabs/logging/hono` wraps every request.
- **Next.js**: Use `withAttrs` once in `middleware.ts` or at the top of an RSC; everything below inherits it.

If neither boundary feels natural for your service, you probably don't need `withAttrs` at all — just use `log.with(...)` to build a request-scoped child logger and pass it down.

### Global logger

```ts
import { log, setGlobalLogger, getGlobalLogger } from "@tetratelabs/logging"

log.info("quick message")
setGlobalLogger(createLogger({ name: "app" }))
```

## GCP / Cloud Logging

For services running on Google Cloud (Cloud Run, GKE, Cloud Functions), use the `@tetratelabs/logging/gcp` subpath to emit logs in [Cloud Logging's structured JSON format](https://cloud.google.com/logging/docs/structured-logging).

### Hono on GCP — request_id correlation

The Hono middleware extracts `request_id` from `x-cloud-trace-context` by default (GCP's Load Balancer / Cloud Run propagator), falling back to `x-request-id`. The trace ID portion (the part before `/SPAN_ID;o=FLAGS`) becomes `request_id`, so log entries correlate 1:1 with Cloud Trace spans in the Cloud Logging UI:

```ts
import { loggingMiddleware } from "@tetratelabs/logging/hono"

// Defaults work for GCP — tries x-cloud-trace-context then x-request-id.
// request_id, method, path are auto-attached to logs (never to metric labels).
app.use(loggingMiddleware())

// Add request-scoped attrs. Use metricAttrs for bounded labels and
// logAttrs for unbounded fields. The middleware enforces the split.
app.use(
  loggingMiddleware({
    metricAttrs: (c) => ({
      // bounded: lands on log AND counter labels
      customer: c.req.header("x-customer-id") ?? "unknown",
      environment: "prod",
    }),
    logAttrs: (c) => ({
      // unbounded: lands on log ONLY, never on counters
      user_agent: c.req.header("user-agent") ?? "",
    }),
  }),
)

// Customize the request_id header priority:
app.use(
  loggingMiddleware({
    requestIdHeaders: ["x-correlation-id", "x-cloud-trace-context"],
  }),
)
```

```ts
import { createGcpLogger, setGlobalLogger } from "@tetratelabs/logging/gcp"

setGlobalLogger(
  createGcpLogger({
    name: "myservice",
    level: process.env.LOG_LEVEL ?? "info",
    project: process.env.GOOGLE_CLOUD_PROJECT, // required for trace correlation
    serviceName: process.env.K_SERVICE, // for Error Reporting (auto on Cloud Run)
    serviceVersion: process.env.K_REVISION, // for Error Reporting (auto on Cloud Run)
  }),
)
```

### What it does

- Maps levels to GCP severity (`DEBUG | INFO | WARNING | ERROR`) — the Cloud Logging UI buckets them correctly.
- Renames `msg` → `message` and emits ISO-8601 `timestamp` per the [LogEntry spec](https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry).
- When `project` is set and a trace is active, rewrites `trace_id`/`span_id` into:
  - `logging.googleapis.com/trace` = `projects/<project>/traces/<trace_id>`
  - `logging.googleapis.com/spanId`
  - `logging.googleapis.com/trace_sampled`
- On `log.error(msg, err)`, emits the [Cloud Error Reporting](https://cloud.google.com/error-reporting/docs/formatting-error-messages) payload (`@type`, `stack_trace`, `serviceContext`) so errors auto-appear in the Error Reporting console.
- Falls back to `K_SERVICE` / `K_REVISION` env (Cloud Run sets these automatically) when `serviceName`/`serviceVersion` aren't passed.

### Cloud Run example

Cloud Run injects `K_SERVICE`, `K_REVISION`, and runs with OTel auto-instrumentation if you enable it. Minimal wiring:

```ts
// index.ts
import { createGcpLogger, setGlobalLogger, log } from "@tetratelabs/logging/gcp"

setGlobalLogger(
  createGcpLogger({
    name: "myservice",
    project: process.env.GOOGLE_CLOUD_PROJECT,
  }),
)

log.info({ port: process.env.PORT }, "server starting")
```

Logs land in Cloud Logging under your service, filterable by severity, with `trace` linked to Cloud Trace and errors flowing into Error Reporting — no separate exporter needed.

### Default value resolution

You can omit `project`, `serviceName`, and `serviceVersion` if the runtime sets the right env vars. The fallback chain (v0.2.1+):

**Project** (for trace correlation):

1. `opts.project`
2. `GOOGLE_CLOUD_PROJECT` (App Engine, Cloud Functions, gcloud CLI, anything that uses gcloud auth)
3. `GCLOUD_PROJECT` (legacy)

**Service name** (for Error Reporting):

1. `opts.serviceName`
2. `K_SERVICE` (Cloud Run, automatic)
3. `OTEL_SERVICE_NAME` (OpenTelemetry standard — GKE, anywhere else)
4. `opts.name` (the logger's own name)
5. `npm_package_name` (set by npm/bun when running scripts)
6. `"unknown"`

**Service version**:

1. `opts.serviceVersion`
2. `K_REVISION` (Cloud Run, automatic)
3. `OTEL_SERVICE_VERSION`
4. `npm_package_version`
5. `"unknown"`

### GKE deployment (the common case)

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
            # The two OTel vars are what the logger reads.
            - name: OTEL_SERVICE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: "metadata.labels['app.kubernetes.io/name']"
            - name: OTEL_SERVICE_VERSION
              valueFrom:
                fieldRef:
                  fieldPath: "metadata.labels['app.kubernetes.io/version']"
            # GCP project — needed for trace correlation in Cloud Logging.
            - name: GOOGLE_CLOUD_PROJECT
              value: "my-gcp-project"
            # Optional: pod / namespace for ad-hoc filtering in the Cloud Logging UI.
            # These don't affect Error Reporting; they're just extra fields on each log.
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

Cloud Logging's GKE log scraper auto-tags entries with `resource.type: k8s_container` and adds pod/namespace/cluster labels at ingestion. You don't need to emit those yourself — the scraper handles it. The Downward API env vars above are for the bits the scraper can't infer (your application's service name and version).

### Cloud Run deployment

Cloud Run injects `K_SERVICE` and `K_REVISION` automatically, so this works with no config beyond the project:

```ts
setGlobalLogger(createGcpLogger({ project: process.env.GOOGLE_CLOUD_PROJECT }))
```

Or if you set `GOOGLE_CLOUD_PROJECT` in the service env:

```ts
setGlobalLogger(createGcpLogger())
```

### What's not auto-detected

GCP metadata server auto-detection (Cloud Run, GKE, GCE) is deliberately out of scope for v0.2.x. The sink is synchronous; the metadata server needs an async HTTP call on init. One line of YAML to set `GOOGLE_CLOUD_PROJECT` beats a 200ms cold-start round-trip.

### Structured fields (v0.3.0)

Beyond severity and trace correlation, the GCP sink emits four optional structured fields that unlock specific Cloud Logging UI features.

`httpRequest` adds Method, URL, Status, Latency columns to the Cloud Logging UI and enables filtering chips. The Hono middleware emits this on every request summary log line. No config needed.

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
    "remoteIp": "203.0.113.1"
  }
}
```

To disable: `loggingMiddleware({ httpRequest: false })`.

`logging.googleapis.com/operation` groups all log lines from a single request under one expandable entry in the Cloud Logging UI. The Hono middleware:

- Emits a "request received" log with `first: true` at request start
- Stamps `{ id, producer }` on every log inside the request scope
- Emits a "request handled" log with `last: true` at request end

```ts
app.use(loggingMiddleware({ operation: { producer: "auth" } }))
// producer defaults to OTEL_SERVICE_NAME when not set explicitly
// To disable: operation: false
```

`logging.googleapis.com/labels` moves bounded keys from `jsonPayload` to indexed labels for fast Cloud Logging filtering. Cap is 64 per entry. Use for low-cardinality values like customer, environment, region.

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

`logging.googleapis.com/sourceLocation` emits `{ file, line, function }` for the call site, used by Cloud Error Reporting for grouping.

```ts
createGcpLogger({ sourceLocation: "error" })  // default: only on error level
createGcpLogger({ sourceLocation: "always" }) // every log (parses stack each call)
createGcpLogger({ sourceLocation: "off" })    // never
```

Parsing `new Error().stack` is not free. The `"error"` default keeps it cheap by only doing it on the level where Error Reporting cares.

`logging.googleapis.com/trace_sampled` is derived from the active OTel `SpanContext.traceFlags`. No config needed. Previously hard-coded to `true`; v0.3.0 reflects reality so tail-sampled traces are correctly marked.

### Known limitations

GCP metadata server project auto-detection is not yet implemented. Coming in the next PR. v0.3.x requires `GOOGLE_CLOUD_PROJECT` env (or explicit `project` option). Cloud Run sets this automatically; on GKE wire it through the Downward API.

## Design rationale

See [RATIONALE.md](./RATIONALE.md) for the full story: metric-before-level ordering, OTel Context model, Next.js Edge support, and more.

## License

Apache License 2.0 — see [LICENSE](./LICENSE)
