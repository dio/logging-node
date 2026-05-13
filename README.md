# @tetratelabs/logging

Structured logging with guaranteed metrics. A Node port of [dio/logging](https://github.com/dio/logging) (Go).

## Features

- **Metrics fire even when logs are silenced.** The core guarantee
- **Built on [pino](https://getpino.io)**. Fast, JSON-native structured logging
- **OpenTelemetry Context integration**. Automatic trace correlation, no explicit ctx threading
- **Next.js first-class**. Works on both Node and Edge runtimes
- **TypeScript-first**. Full type safety

## Install

```sh
pnpm add @tetratelabs/logging pino
npm install @tetratelabs/logging pino
yarn add @tetratelabs/logging pino
```

## Quick start

```ts
import { createLogger, log, withAttrs, withLogAttrs } from "@tetratelabs/logging"
import { metrics } from "@opentelemetry/api"

// Create a logger (or use the global singleton)
const logger = createLogger({ name: "myapp", level: "info" })

// Structured logging (pino-style: attrs first, message second)
logger.info({ user_id: "123", provider: "google" }, "user signin")

// With metrics (fires before level check)
const requests = metrics.getMeter("myapp").createCounter("requests_total")
logger.metric(requests).info("handled")

// Bounded attrs (logs AND metric labels) for customer, region, env, role
await withAttrs({ customer: "acme" }, async () => {
  logger.info("processing") // log + metric labels both include customer
})

// Unbounded attrs (logs only, NEVER on metric labels) for request_id, user_id, ip
await withLogAttrs({ request_id: req.id }, async () => {
  logger.info("processing") // log includes request_id; counters do not
})

// Or use the global singleton
import { log } from "@tetratelabs/logging"
log.info("quick message")
```

## Next.js setup

See [examples/nextjs/README.md](./examples/nextjs/README.md) for a working example covering edge middleware, Node.js API routes, and the OpenTelemetry instrumentation hook.

Short version:

```js
// next.config.js
module.exports = {
  serverExternalPackages: ["@tetratelabs/logging", "pino", "thread-stream"],
}
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerOTel } = await import("@vercel/otel")
    registerOTel({ serviceName: "myapp" })
    const { createLogger, setGlobalLogger, parseLevel } = await import("@tetratelabs/logging")
    setGlobalLogger(createLogger({ name: "myapp", level: parseLevel(process.env.LOG_LEVEL) }))
  }
}
```

```ts
// middleware.ts (edge)
import { withLogAttrs, log } from "@tetratelabs/logging"
export default async function middleware(req: Request) {
  return await withLogAttrs(
    { request_id: req.headers.get("x-request-id") ?? crypto.randomUUID() },
    async () => {
      /* ... */
    },
  )
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

The `level` you pass is threaded into the underlying pino sink, so
`createLogger({ level: "debug" })` actually emits debug records on the
default stream. An explicit `pino.level` still wins if you set both.

### `parseLevel(value?)`

Accepts a string (typically `process.env.LOG_LEVEL`) and returns a valid
`Level`. Unknown values fall back to `"info"` rather than silencing the
logger. Pino aliases are mapped for ergonomics: `"trace"` → `"debug"`,
`"fatal"` → `"error"`.

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
// WRONG: request_id leaks to every counter label as a cardinality bomb.
await withAttrs({ request_id, customer_id }, async () => {
  log.metric(orders).info("order placed")
})
```

```ts
// RIGHT: bounded labels and unbounded fields kept separate.
await withAttrs({ customer_id }, async () => {
  await withLogAttrs({ request_id }, async () => {
    log.metric(orders).info("order placed")
  })
})
```

The Hono middleware (`@tetratelabs/logging/hono`) handles this split automatically. See the Hono section below.

## When to use what

The library gives you four ways to attach attributes. Pick deliberately. The first thing to decide is whether your attribute is bounded (safe on metric labels) or unbounded (logs only).

| You want…                                                                            | Use                            | Example                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| Attach attrs to **one log line**                                                     | per-call `attrs` arg           | `log.info({ user_id }, "ok")`                                                  |
| Attach attrs to **many calls in the same function**                                  | `log.with(...)` (child logger) | `const reqLog = log.with({ request_id }); reqLog.info(...)`                    |
| Attach **bounded** attrs to everything downstream (logs + metric labels)             | `withAttrs(...)`               | middleware sets `customer`, every nested log + metric inherits it              |
| Attach **unbounded** attrs to everything downstream (logs only, never metric labels) | `withLogAttrs(...)`            | middleware sets `request_id`, every nested log inherits it but counters do not |

### Rule of thumb

> **Use `withAttrs` and `withLogAttrs` only at boundaries** (middleware, route handlers, the top of a request) where you set request-scoped attrs **once**. Everywhere else, prefer plain `log.info(msg, attrs)` or `log.with(attrs)`.

In practice this means **your business code almost never writes either directly**. The Hono middleware (`@tetratelabs/logging/hono`) wraps the chain for you with the bounded/unbounded split already done; in Next.js you write it once per request boundary.

### Why they're intrusive

It's worth knowing what you're trading for the convenience:

1. **Indents your code.** Your function body lives inside a callback. Early returns and top-level `return` become more awkward.
2. **Async-only contract.** Works because OTel Context propagates through `await`. If you spawn a worker thread or pass a callback to a queue that runs outside the request's async tree, attrs are lost.
3. **Small but real overhead.** AsyncLocalStorage adds ~50–200 ns per `await`. Negligible for HTTP services; measurable in hot loops doing 100k+ awaits/sec.
4. **Hidden control flow.** A log line in `loadUser` mysteriously has `tenant=acme` attached. Great for ops, surprising for new readers.

### When to skip both entirely

```ts
// ❌ Overkill: the attr is only used once.
await withLogAttrs({ user_id }, async () => {
  log.info("user fetched")
})

// ✅ Just pass it directly.
log.info({ user_id }, "user fetched")

// ❌ Overkill: used in one function, no nested awaits that need it.
async function loadUser(id: string) {
  return await withLogAttrs({ user_id: id }, async () => {
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

### When `withAttrs` and `withLogAttrs` earn their keep

```ts
// Middleware sets request-scoped attrs ONCE, with the bounded/unbounded split.
app.use(async (c, next) => {
  // Bounded: customer is a small enum, safe on metric labels.
  await withAttrs({ customer: c.req.header("x-customer") ?? "unknown" }, async () => {
    // Unbounded: request_id is per-request, must stay off counter labels.
    await withLogAttrs({ request_id: c.req.header("x-request-id") ?? crypto.randomUUID() }, () =>
      next(),
    )
  })
})

// 20 layers down, in a util you didn't write:
// log line gets customer + request_id; counter labels get customer only.
log.info("cache miss")
log.metric(misses).info("cache miss")
```

This is the only pattern where the indentation cost is paid by _one_ file (the middleware) and _zero_ business code.

### Already covered for you

You get this for free, without writing `withAttrs` / `withLogAttrs` yourself:

- **Hono**: `app.use(loggingMiddleware())` from `@tetratelabs/logging/hono` wraps every request with the cardinality split already enforced (`metricAttrs` for bounded, `logAttrs` for unbounded). See [docs/hono.md](./docs/hono.md).
- **Next.js**: use `withLogAttrs` once in `middleware.ts` for `request_id`/`path`; everything below inherits it. See [examples/nextjs/README.md](./examples/nextjs/README.md).

If neither boundary feels natural for your service, you probably don't need either function. Just use `log.with(...)` to build a request-scoped child logger and pass it down.

### Global logger

```ts
import { log, setGlobalLogger, getGlobalLogger } from "@tetratelabs/logging"

log.info("quick message")
setGlobalLogger(createLogger({ name: "app" }))
```

## GCP / Cloud Logging

See [docs/gcp.md](./docs/gcp.md) for the full GCP adapter docs: severity mapping, trace correlation, Error Reporting payloads, structured fields (`httpRequest`, `operation`, `labelKeys`, `sourceLocation`, `trace_sampled`), project auto-detection, and Cloud Run / GKE deployment patterns.

Short version:

```ts
import { createGcpLogger, setGlobalLogger } from "@tetratelabs/logging/gcp"

setGlobalLogger(createGcpLogger({ name: "myservice" }))
```

Project ID resolves automatically via `GOOGLE_CLOUD_PROJECT` env (Cloud Run sets it), then the GCP metadata server via [`gcp-metadata`](https://www.npmjs.com/package/gcp-metadata) (Cloud Run, GKE, GCE, App Engine). Pass `project:` explicitly to skip detection. Pass `projectAutoDetect: false` to disable the metadata fetch.

## Hono middleware

See [docs/hono.md](./docs/hono.md) for the full Hono middleware docs: `metricAttrs` / `logAttrs` cardinality split, request ID resolution, operation grouping, structured HTTP request emission.

Short version:

```ts
import { loggingMiddleware } from "@tetratelabs/logging/hono"

app.use("*", loggingMiddleware())
// request_id, method, path attached to every log; httpRequest + operation
// emitted automatically when paired with createGcpLogger.
```

## Design rationale

See [RATIONALE.md](./RATIONALE.md) for the full story: metric-before-level ordering, OTel Context model, Next.js Edge support, and more.

## License

Apache License 2.0. See [LICENSE](./LICENSE)
