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

### Global logger

```ts
import { log, setGlobalLogger, getGlobalLogger } from "@tetratelabs/logging"

log.info("quick message")
setGlobalLogger(createLogger({ name: "app" }))
```

## Design rationale

See [RATIONALE.md](./RATIONALE.md) for the full story: metric-before-level ordering, OTel Context model, Next.js Edge support, and more.

## License

Apache License 2.0 — see [LICENSE](./LICENSE)
