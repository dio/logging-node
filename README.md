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

// Structured logging
logger.info("user signin", { user_id: "123", provider: "google" })

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

Scopes attributes to an async function. Attributes merge into all logs and metrics within.

```ts
await withAttrs({ customer_id: "acme" }, async () => {
  logger.info("order placed") // includes customer_id
})
```

## When to use what

The library gives you three ways to attach attributes. Pick deliberately — `withAttrs` is the most powerful but also the most intrusive.

| You want…                                                                        | Use                            | Example                                                     |
| -------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Attach attrs to **one log line**                                                 | per-call `attrs` arg           | `log.info("ok", { user_id })`                               |
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
log.info("user fetched", { user_id })

// ❌ Overkill — used in one function, no nested awaits that need it.
async function loadUser(id: string) {
  return await withAttrs({ user_id: id }, async () => {
    const row = await db.users.find(id)
    log.info("loaded", { row_count: row ? 1 : 0 })
    return row
  })
}

// ✅ Child logger does the job with less ceremony.
async function loadUser(id: string) {
  const reqLog = log.with({ user_id: id })
  const row = await db.users.find(id)
  reqLog.info("loaded", { row_count: row ? 1 : 0 })
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

// Defaults work for GCP — tries x-cloud-trace-context then x-request-id:
app.use(loggingMiddleware())

// Or customize the header priority:
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

log.info("server starting", { port: process.env.PORT })
```

Logs land in Cloud Logging under your service, filterable by severity, with `trace` linked to Cloud Trace and errors flowing into Error Reporting — no separate exporter needed.

### Known limitations (v0.1.x)

The adapter covers the cases that _break_ if missing (severity, trace ID format, Error Reporting). Some Cloud Logging UI niceties aren't wired yet — see [#13](https://github.com/dio/logging-node/issues/13) for the v0.2.0 roadmap (`httpRequest` filtering, `operation` log grouping, `labels` indexing, source location, project auto-detection).

## Design rationale

See [RATIONALE.md](./RATIONALE.md) for the full story: metric-before-level ordering, OTel Context model, Next.js Edge support, and more.

## License

Apache License 2.0 — see [LICENSE](./LICENSE)
