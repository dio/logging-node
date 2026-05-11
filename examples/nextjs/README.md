# Next.js Example

A Next.js 15 App Router application demonstrating @tetratelabs/logging.

## Run

```bash
# From repository root:
pnpm install                  # installs all workspace packages
pnpm -C examples/nextjs dev   # or: PORT=3456 pnpm -C examples/nextjs dev
```

## What to look for in logs

- `instrumentation.ts` initializes the global logger via `@vercel/otel`
- `app/page.tsx` (RSC) logs within `withAttrs({ tenant, page })`
- `app/api/hello/route.ts` logs within `withAttrs({ request_id, route })`
- `app/api/health/route.ts` is a readiness probe (no logs)
- `middleware.ts` (edge runtime) logs via `withAttrs` with runtime-detected sink

Expected log lines (pretty-printed by default in development):

```
{"level":"info","msg":"rendering home page","tenant":"demo","page":"home",...}
{"level":"info","msg":"hello called","request_id":"...","route":"/api/hello",...}
{"level":"info","msg":"edge: incoming","request_id":"...","path":"/api/hello",...}
```

The edge logger uses JSON lines (console.log) since pino is not available in Edge runtime.
