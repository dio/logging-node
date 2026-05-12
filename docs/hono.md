# Hono middleware

`@tetratelabs/logging/hono` exports `loggingMiddleware`, a single middleware that:

- Resolves a stable `request_id` from `x-cloud-trace-context` (GCP) or `x-request-id`
- Attaches request-scoped attrs to the OTel context so every nested log inherits them
- Enforces the cardinality split: bounded labels reach metrics; unbounded fields stay log-only
- Emits structured GCP fields (`httpRequest`, `operation`) when the GCP sink is active
- Logs a `request received` line at start and `request handled` / `request failed` at end

## Quick start

```ts
import { Hono } from "hono"
import { loggingMiddleware } from "@tetratelabs/logging/hono"

const app = new Hono()
app.use("*", loggingMiddleware())

app.get("/v1/echo", (c) => c.text("ok"))
```

Defaults give you `request_id`, `method`, `path` on every log line for the request, plus a structured `httpRequest` and operation grouping when paired with `createGcpLogger`.

## Options

### `metricAttrs` — bounded labels

Keys returned here propagate to BOTH log records AND counter labels. Use for bounded enums.

```ts
app.use(
  loggingMiddleware({
    metricAttrs: (c) => ({
      customer: c.req.header("x-customer-id") ?? "unknown",
      environment: "prod",
    }),
  }),
)
```

These appear on every `log.metric(counter).info(...)` call inside the request as counter labels.

### `logAttrs` — log-only fields

Keys returned here decorate log records but NEVER reach counter labels. Use for unbounded values.

```ts
app.use(
  loggingMiddleware({
    logAttrs: (c) => ({
      user_agent: c.req.header("user-agent") ?? "",
      tenant_url: c.req.header("x-tenant-url") ?? "",
    }),
  }),
)
```

The middleware auto-adds `request_id`, `method`, and `path` to this scope. Anything in your `logAttrs` callback is merged on top.

### `requestIdHeaders` — header priority

```ts
app.use(
  loggingMiddleware({
    requestIdHeaders: ["x-correlation-id", "x-cloud-trace-context", "x-request-id"],
  }),
)
```

Defaults to `["x-cloud-trace-context", "x-request-id"]`. The trace ID portion (before `/SPAN_ID;o=FLAGS`) of `x-cloud-trace-context` becomes the `request_id`, so logs correlate 1:1 with Cloud Trace spans. Set `requestIdHeaders: []` to skip header resolution and always generate a UUID.

### `generateRequestId` — custom generator

```ts
app.use(loggingMiddleware({ generateRequestId: () => myOpaqueId() }))
```

Wins over header resolution when set.

### `operation` — Cloud Logging request grouping

```ts
app.use(loggingMiddleware({ operation: { producer: "auth" } }))
app.use(loggingMiddleware({ operation: false })) // disable
```

Producer defaults to `OTEL_SERVICE_NAME`. The middleware:

- Logs `"request received"` with `first: true`
- Stamps `{ id, producer }` on every nested log
- Logs `"request handled"` / `"request failed"` with `last: true`

The Cloud Logging UI uses these flags to collapse the request into one expandable entry.

### `httpRequest` — Cloud Logging structured request field

```ts
app.use(loggingMiddleware({ httpRequest: false })) // disable
```

Enabled by default. Adds Method, URL, Status, Latency columns and filter chips in the Cloud Logging UI. See [docs/gcp.md](./gcp.md) for the emitted shape.

### `logger` — non-global logger

```ts
const logger = createGcpLogger({ name: "auth" })
app.use(loggingMiddleware({ logger }))
```

Uses a specific logger instance instead of the global one.

### Legacy `attrs` (deprecated, removed in v0.4.0)

```ts
// Deprecated. Auto-splits known unbounded keys (request_id, trace_id,
// span_id, method, path, url, user_agent, remote_ip, referer) into
// the log-only scope; everything else lands on metric-safe.
app.use(
  loggingMiddleware({
    attrs: (c) => ({
      customer: c.req.header("x-customer-id"),
      user_agent: c.req.header("user-agent"),
    }),
  }),
)
```

Logs a one-time deprecation warning to stderr. Migrate to `metricAttrs` + `logAttrs`. See [docs/migration-0.3.md](./migration-0.3.md).

## What gets logged

For a request `GET /v1/echo`, the middleware emits at least two logs (plus anything you log in the handler):

```jsonc
// request received
{
  "level": 30,
  "msg": "request received",
  "request_id": "abc-123",
  "method": "GET",
  "path": "/v1/echo",
  "operation": { "id": "abc-123", "producer": "auth", "first": true }
}

// (your handler logs here, all carrying request_id + method + path + operation)

// request handled
{
  "level": 30,
  "msg": "request handled",
  "request_id": "abc-123",
  "method": "GET",
  "path": "/v1/echo",
  "status": 200,
  "duration_ms": 45,
  "http_request": { "requestMethod": "GET", "requestUrl": "/v1/echo", "status": 200, "latency": "0.045s" },
  "operation": { "id": "abc-123", "producer": "auth", "last": true }
}
```

When paired with `createGcpLogger`, `operation` and `http_request` are rewritten into `logging.googleapis.com/operation` and `httpRequest`. With the plain pino sink, they appear as flat fields.

## Failure path

When a handler throws, the middleware logs `"request failed"` at error level with the error attached under `err`:

```jsonc
{
  "level": 50,
  "msg": "request failed",
  "err": { "name": "TypeError", "message": "...", "stack": "..." },
  "status": 500,
  "duration_ms": 12,
  "operation": { "id": "abc-123", "producer": "auth", "last": true },
}
```

With the GCP sink, this produces the Cloud Error Reporting payload (`@type`, `stack_trace`, `serviceContext`) so the error appears in the Error Reporting console.

## Bun compatibility

The library installs `AsyncLocalStorageContextManager` at module load because Bun does not implement `async_hooks.createHook`. The middleware works on Bun, Node 24+, and any runtime that supports `AsyncLocalStorage`. If another OTel package registers a different context manager first, the install is skipped silently and request-scoped attrs stop propagating. If logs are missing `request_id`, check the order of OTel SDK boot vs `@tetratelabs/logging` import.
