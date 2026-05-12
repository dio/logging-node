# Next.js example

Demonstrates `@tetratelabs/logging` running across the three Next.js boundaries:

- Edge middleware (`middleware.ts`)
- Node.js API routes (`app/api/*/route.ts`)
- OpenTelemetry instrumentation hook (`instrumentation.ts`)

Same logger, same context, same `withLogAttrs` propagation. The library auto-detects the runtime and uses the correct sink (console-JSON on edge, pino on Node).

## Run

```bash
pnpm install
pnpm dev
```

```bash
# In another terminal
curl localhost:3000/api/hello
curl localhost:3000/api/health
```

Logs print to the dev server stdout. Both edge and Node logs share the same `request_id` because the edge middleware uses `withLogAttrs` to attach it before the request reaches the route handler.

## What it shows

### Edge middleware

`middleware.ts` runs on the edge runtime (no `pino`, no `async_hooks`). It resolves `request_id` from the `x-request-id` header (or generates one) and attaches it via `withLogAttrs` so the downstream route inherits it without re-extracting from headers.

### Node.js API route

`app/api/hello/route.ts` runs in the Node runtime. The same `log.info(...)` call automatically carries the `request_id` and `path` from the edge middleware via OTel context propagation.

### Instrumentation hook

`instrumentation.ts` is Next.js's official hook for runtime setup. We use it to register the AsyncLocalStorage context manager and configure the global logger before any request hits the server.

## Build

```bash
pnpm build
pnpm start
```

The build produces the standard Next output. Both runtimes (edge and Node) link against the same `@tetratelabs/logging` package, but resolve to different runtime entry points via the package's `exports` map (`./edge` for edge, default for Node).

## Files

```
examples/nextjs/
├── middleware.ts            # edge: resolves request_id, attaches via withLogAttrs
├── instrumentation.ts       # Next.js runtime hook: sets up the global logger
├── app/api/hello/route.ts   # node: log.info inherits request_id from edge
├── app/api/health/route.ts  # node: simplest health check
├── next.config.ts
└── package.json
```

## Why withLogAttrs (not withAttrs)

`request_id` and `path` are unbounded. If they used `withAttrs`, every downstream `log.metric(counter).info(...)` call would label the counter with the per-request values, creating one new time series per request. `withLogAttrs` keeps them on log records and off metrics. See the main [README](../../README.md) section on bounded vs unbounded attrs.
