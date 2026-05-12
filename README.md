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
    const { createLogger, setGlobalLogger } = await import("@tetratelabs/logging")
    setGlobalLogger(createLogger({ name: "myapp", level: process.env.LOG_LEVEL ?? "info" }))
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

See [docs/gcp.md](./docs/gcp.md) for the full GCP adapter docs: severity mapping, trace correlation, Error Reporting payloads, structured fields (`httpRequest`, `operation`, `labelKeys`, `sourceLocation`, `trace_sampled`), and Cloud Run / GKE deployment patterns.

Short version:

```ts
import { createGcpLogger, setGlobalLogger } from "@tetratelabs/logging/gcp"

setGlobalLogger(
  createGcpLogger({
    name: "myservice",
    project: process.env.GOOGLE_CLOUD_PROJECT,
  }),
)
```

On Cloud Run, omit `project` and the sink reads `GOOGLE_CLOUD_PROJECT` from env (Cloud Run sets it). On GKE, wire it through the Downward API. See [docs/gcp.md](./docs/gcp.md) for the full pattern.

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

Apache License 2.0 — see [LICENSE](./LICENSE)
