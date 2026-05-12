# Migrating to v0.3.0

v0.3.0 introduces a hard split between metric-safe and log-only attribute scopes to fix a cardinality bug found in real production use. The bug: any unbounded field (`request_id`, `user_id`, `ip`) attached via `withAttrs` leaked into counter labels, creating one new time series per request.

This doc covers what changed, what's automatic, and what you need to migrate by hand.

## What changed

Two new exports:

- `withLogAttrs(attrs, fn)` — attach log-only attributes
- `setLogAttrsOnContext(ctx, attrs)` — primitive used by the above

The Hono middleware (`@tetratelabs/logging/hono`) gained two options:

- `metricAttrs: (c) => ({...})` — bounded labels (logs AND metrics)
- `logAttrs: (c) => ({...})` — unbounded fields (logs only)

The legacy `attrs` option is deprecated but still works for one release. It auto-splits using a hard-coded list of known unbounded keys: `request_id`, `trace_id`, `span_id`, `method`, `path`, `url`, `user_agent`, `remote_ip`, `referer`. The middleware logs a `console.warn` once when this fallback kicks in.

## Migration matrix

| What you have today                              | What to do                                                            | When          |
| ------------------------------------------------ | --------------------------------------------------------------------- | ------------- |
| `withAttrs({ request_id, customer })`            | Split into `withAttrs({ customer })` + `withLogAttrs({ request_id })` | Now (v0.3.0)  |
| `withAttrs({ customer })` with only bounded keys | No change needed                                                      | —             |
| `loggingMiddleware({ attrs: (c) => ({...}) })`   | Move bounded keys to `metricAttrs`, unbounded to `logAttrs`           | Before v0.4.0 |
| `loggingMiddleware()` with no options            | No change needed                                                      | —             |

## Step-by-step

### 1. Replace `withAttrs` with `withLogAttrs` for unbounded fields

Before:

```ts
await withAttrs({ request_id: req.headers.get("x-request-id"), user_id: "u-123" }, async () => {
  log.info("doing thing")
  log.metric(counter).info("doing thing")
  //         ^^^^^^^^^ counter labels now include request_id and user_id
})
```

After:

```ts
await withLogAttrs({ request_id: req.headers.get("x-request-id"), user_id: "u-123" }, async () => {
  log.info("doing thing")
  log.metric(counter).info("doing thing")
  //         ^^^^^^^^^ counter has NO request_id or user_id labels
})
```

Both calls still produce log lines decorated with `request_id` and `user_id`.

### 2. Mixed bounded + unbounded

Compose the two:

```ts
await withAttrs({ customer: "acme" }, async () => {
  await withLogAttrs({ request_id }, async () => {
    log.metric(counter).info("event")
    // counter labels: customer="acme"
    // log line:       customer="acme", request_id="..."
  })
})
```

Order does not matter. Both contexts compose.

### 3. Hono middleware

Before:

```ts
app.use(
  loggingMiddleware({
    attrs: (c) => ({
      customer: c.req.header("x-customer-id"),
      user_agent: c.req.header("user-agent"),
    }),
  }),
)
```

After:

```ts
app.use(
  loggingMiddleware({
    metricAttrs: (c) => ({
      customer: c.req.header("x-customer-id"),
    }),
    logAttrs: (c) => ({
      user_agent: c.req.header("user-agent"),
    }),
  }),
)
```

If you don't migrate, the legacy `attrs` callback still works for one release. You'll see a one-time deprecation warning on stderr.

### 4. Next.js edge middleware

Before:

```ts
import { withAttrs, log } from "@tetratelabs/logging"

export default async function middleware(req) {
  return await withAttrs(
    { request_id: req.headers.get("x-request-id"), path: new URL(req.url).pathname },
    async () => {
      log.info("incoming")
      return NextResponse.next()
    },
  )
}
```

After:

```ts
import { withLogAttrs, log } from "@tetratelabs/logging"

export default async function middleware(req) {
  return await withLogAttrs(
    { request_id: req.headers.get("x-request-id"), path: new URL(req.url).pathname },
    async () => {
      log.info("incoming")
      return NextResponse.next()
    },
  )
}
```

## What does NOT change

- `log.info(...)`, `log.error(...)`, all call signatures
- `createLogger`, `createGcpLogger`, all options
- `log.with({...})` builder
- `log.metric(c).info(...)` call signature
- Trace correlation (still automatic via OTel context)
- GCP severity mapping, Error Reporting payloads, env fallbacks
- Edge runtime support

## How to test the fix in your service

Spike with a counter that should NOT be labelled by `request_id`:

```ts
const counter = metrics.getMeter("test").createCounter("test.events")

app.get("/test", async (c) => {
  log.metric(counter).info("event")
  return c.text("ok")
})

// Fire 5 requests, then check /metrics:
//   v0.2.x: 5 separate series, each with a unique request_id label
//   v0.3.x: 1 series, no request_id label
```

If you still see one series per request after upgrading, check:

1. You're on `@tetratelabs/logging@^0.3.0` (verify with `npm ls @tetratelabs/logging`)
2. You replaced `withAttrs` with `withLogAttrs` for the unbounded fields
3. Your Hono middleware uses `metricAttrs`/`logAttrs` (or relies on the auto-split shim)

## Deprecation timeline

- v0.3.0 (this release): `attrs` option in `loggingMiddleware` keeps working with a deprecation warning
- v0.4.0: `attrs` option removed. Must use `metricAttrs` and `logAttrs`

## Why this is a hard split, not "just be careful"

OpenTelemetry counters allocate a new time series per unique combination of label values. There is no soft cap. A service at 1k RPS for one hour with `request_id` as a label produces 3.6 million series. Storage backends (Cloud Monitoring, Prometheus, Mimir) either bill you for every series or simply reject after a threshold. Either way the metric becomes useless.

The two-scope API encodes the rule in the type. You cannot accidentally label a counter with `request_id` if `request_id` only exists in the log-only scope.
