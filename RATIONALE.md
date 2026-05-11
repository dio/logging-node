# @tetratelabs/logging — Rationale

A Node port of [dio/logging](https://github.com/dio/logging) (Go). Same core
guarantee, idiomatic Node ergonomics.

---

## Core guarantee (ported verbatim)

**Metrics fire even when logs are silenced.**

In production you turn Info logs down to reduce noise, but you still want your
counters and histograms to record. We achieve this by ordering the metric
call **before** the level check:

```ts
info(msg, ...kvs) {
  this.metric?.add(1, this.#otelAttrs(kvs))   // unconditional
  if (this.#level > LevelInfo) return          // level check second
  this.#pino.info(this.#fields(kvs), msg)
}
```

This decouples operational verbosity from alerting signal — the right tradeoff
for high-traffic services. Same line as Go:

```ts
log.metric(reserveErrs).error("reserve failed", err, { cluster })
// → log:    level=ERROR msg="reserve failed" trace_id=… span_id=… cluster=openai err=…
// → metric: reserve_errors_total{cluster="openai"} += 1
```

---

## Logger backend: pino

Picked over winston / bunyan / roll-our-own because:

- **JSON-native, fastest in class.** Pino's hot path is ~5× winston for
  structured output, which matches a hot AI-gateway request path.
- **Child loggers are free.** `pino.child(bindings)` is the natural primitive
  for `logger.with(kvs)` — no wrapping overhead.
- **No transports in hot path.** Pretty-printing / shipping happens in a
  worker thread or downstream process. Same philosophy as slog handlers.
- **Stable API, no peer-dep churn.** Important for a logging lib that wants
  to live in many services.

We re-export a thin facade — callers never see `pino` types in their
function signatures. We can swap the backend later without an API break.

---

## Context model: OTel Context with a private key (Next.js-aware)

Go forces explicit `ctx`. Node has two idioms — and Next.js narrows the
choice for us:

| Approach                                               | Verdict                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A) Explicit ctx everywhere                             | Un-idiomatic in Node; doubly painful in RSC.                                                            |
| B) Our own AsyncLocalStorage                           | Works in Node runtime, **fails on Edge** unless polyfilled. Also duplicates OTel's own context manager. |
| **C) OTel Context (private key) + `context.active()`** | **Chosen.** One context, reused by OTel SDK and `@vercel/otel`. Works on both Next runtimes.            |

Concretely: business attrs (`customer_id`, `tenant_id`, …) live under a
private symbol-keyed entry in the active OTel `Context`. We never touch
Baggage (that's for cross-process propagation; our attrs are
in-process-only and would pollute trace headers).

### Default path (idiomatic Node + Next-friendly)

```ts
// Anywhere — middleware, route handler, server action, RSC:
import { withAttrs, log } from "@tetratelabs/logging"

await withAttrs({ customer_id, environment, service_name: "valet" }, async () => {
  // Zero plumbing downstream:
  log.metric(requests).info("request handled")
  // → attrs merged from active context, trace_id/span_id from active span
})
```

`withAttrs` is implemented as `context.with(setAttrs(context.active(), …), fn)`
— pure OTel API, no extra ALS. The OTel SDK's `AsyncHooksContextManager`
(set up by `@vercel/otel` or `NodeSDK`) handles propagation.

### Escape hatch

```ts
log.context(otelCtx).metric(requests).info("request handled")
```

For tests, worker threads, or any place you want to pin a specific OTel
context instead of `context.active()`.

### Why this is better than separate ALS

- **One source of truth.** OTel SDK already runs an ALS context manager;
  adding our own doubles the work and risks drift.
- **Works on Edge.** Edge runtime supports OTel Context via the
  no-op/SDK context managers; a separate ALS would force a polyfill or
  a `process.env.NEXT_RUNTIME` branch.
- **Free composition with spans.** `tracer.startActiveSpan` automatically
  carries our attrs through; child spans inherit them.

---

## Metrics: thin wrapper, OTel-first, no global sink registry

The Go version uses `tetratelabs/telemetry.SetGlobalMetricSink` so library
code can declare metrics without depending on an implementation. Node
doesn't need this layer:

- `@opentelemetry/api` already provides global `metrics.getMeter(name)`.
- Libraries grab a `Meter` directly; the app wires the `MeterProvider`.
- No registration ceremony, no init ordering bugs.

We expose a tiny `Counter` interface so user code reads cleanly:

```ts
import { metrics } from "@opentelemetry/api"
const m = metrics.getMeter("valet")
const reserveErrs = m.createCounter("reserve_errors_total")

log.metric(reserveErrs).error("reserve failed", err, { cluster })
```

`log.metric(x)` accepts anything with `add(value, attrs)` — covers
`@opentelemetry/api` Counter, UpDownCounter, and Histogram (`record`-style
also supported via duck-typing).

---

## OTel trace correlation

Same one-shot lookup as Go. When `log.context(ctx)` is called, or when ALS
has captured an OTel context, we extract the active span:

```ts
const span = trace.getSpan(otelCtx)
if (span) {
  const sc = span.spanContext()
  if (isSpanContextValid(sc)) {
    fields.trace_id = sc.traceId
    fields.span_id = sc.spanId
  }
}
```

No manual extraction, no propagator setup needed by callers.

---

## Cross-cutting attrs (`SetAttrs` equivalent)

Go's `SetAttrs(ctx, …)` becomes Node's `withAttrs(attrs, fn)` (ALS-scoped)
or `setAttrs(attrs)` (mutates current ALS frame). Attrs flow to **both**
log fields and metric labels — matching the Go behavior where attrs from
context are passed through `RecordContext`.

```ts
withAttrs({ customer_id, environment }, () => {
  log.metric(requests).info("ok")
  // log:    msg=ok customer_id=acme environment=prod trace_id=…
  // metric: requests_total{customer_id="acme",environment="prod"} += 1
})
```

This is the exact "v0.1.3 regression" you fixed in Go (otelHistogram/Gauge
were ignoring `contextAttrs`) — we'll get it right from day one with a
regression test mirroring `otelsink_attrs_test.go`.

---

## Next.js as a first-class target

This library is designed to be used in Next.js apps (App Router + Edge +
Server Actions + RSC). The constraints shape several decisions:

### Two runtimes, one API

Next.js runs server code in two places:

- **Node runtime** (default — route handlers, server actions, RSC):
  full pino, AsyncHooks-backed OTel context, all features.
- **Edge runtime** (middleware, opted-in routes): V8 isolates, **no
  `pino`, no worker threads, no `fs`, no `async_hooks`**.

We keep the API uniform with a runtime-detected sink:

```ts
// Internally:
const isEdge = typeof process !== "undefined" && process.env.NEXT_RUNTIME === "edge"
const sink = isEdge ? createEdgeSink() : createPinoSink(opts)
```

The Edge sink is a tiny console-JSON writer (`console.log(JSON.stringify(…))`).
Same fields, same level filtering, same metric-before-level ordering.
Loses pino's perf — irrelevant on Edge, which is rate-limited anyway.

Build-time: the package's `exports` map uses the `"edge-light"` /
`"workerd"` conditions so bundlers pick the Edge entry automatically:

```jsonc
"exports": {
  ".": {
    "edge-light": "./dist/edge.js",
    "workerd":    "./dist/edge.js",
    "default":    "./dist/node.js"
  }
}
```

This means **`pino` never enters the Edge bundle** — Turbopack/webpack
won't even try to resolve `worker_threads` or `thread-stream`.

### `serverExternalPackages` (Node runtime)

Pino doesn't bundle cleanly through webpack/Turbopack: it uses dynamic
`require` for transports and worker threads. Standard fix — users add:

```js
// next.config.js
module.exports = {
  serverExternalPackages: ["@tetratelabs/logging", "pino", "thread-stream"],
}
```

We document this prominently in the README. (Older Next: same key under
`experimental.serverComponentsExternalPackages`.)

### `instrumentation.ts` — the canonical wiring point

Next's `instrumentation.ts` runs once at server boot, before any request.
This is where users wire OTel + our logger. We ship a copy-paste:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerOTel } = await import("@vercel/otel")
    registerOTel({ serviceName: "valet" })

    const { createLogger, setGlobalLogger } = await import("@tetratelabs/logging")
    setGlobalLogger(createLogger({ name: "valet", level: process.env.LOG_LEVEL ?? "info" }))
  }
  // Edge: nothing to do — global logger lazy-inits on first use.
}
```

`@vercel/otel` registers an ALS-backed OTel context manager, so our
`context.active()` reads work out of the box. No extra setup.

### HMR-safe singleton

Dev mode re-evaluates modules on every save. Without protection, a new
logger (and a new MeterProvider, if users wire it via our helper) is
created per HMR cycle — leaks file descriptors, duplicates metric streams.
Standard Next pattern, same as the Prisma example:

```ts
// internal/global.ts
const g = globalThis as unknown as { __tetratelabs_logger?: Logger }
export function getGlobalLogger(): Logger {
  return (g.__tetratelabs_logger ??= createLogger(/* defaults */))
}
```

Users who call `setGlobalLogger` in `instrumentation.ts` get the same
cache slot — overwriting it is idempotent across HMR.

### Env-driven configuration

Vercel users expect everything to be `LOG_LEVEL=debug` away. We honor:

- `LOG_LEVEL` — initial level (`debug|info|warn|error|none`).
- `LOG_PRETTY` — when `"1"` and not in production, route pino through
  `pino-pretty` (Node runtime only; ignored on Edge).
- `NEXT_RUNTIME` — read internally to pick sink; never user-facing.

Runtime `log.setLevel(…)` still works for dynamic adjustment.

### RSC / Server Actions usage

No middleware needed. Anywhere in an async server tree:

```ts
// app/(some)/page.tsx (RSC)
export default async function Page() {
  return await withAttrs({ tenant: getTenant() }, async () => {
    const data = await loadData()         // logs inside loadData get tenant=…
    return <View data={data} />
  })
}
```

`withAttrs` returns the inner promise's value, so it composes naturally
with `async` server components.

### Edge middleware example

```ts
// middleware.ts
import { withAttrs, log } from "@tetratelabs/logging"
export const config = { matcher: "/api/:path*" }

export default async function middleware(req: Request) {
  return await withAttrs(
    { request_id: crypto.randomUUID(), path: new URL(req.url).pathname },
    async () => {
      log.info("incoming")
      // ... do work; logs downstream inherit attrs
    },
  )
}
```

Same API; runs on Edge; logs land as JSON lines in Vercel logs.

---

## API shape

```ts
// Construction
const log = createLogger({ name: "valet", level: "info", pino: pinoOpts? })

// Level (runtime adjustable)
log.setLevel("error")          // info logs silenced; metrics still fire

// Structured kvs
log.info("msg", { key: "v" })       // object form (idiomatic)
log.info("msg", "key", "v")         // varargs form (Go-style, also supported)

// Child logger with persistent kvs
const reqLog = log.with({ request_id })

// Context override (skip ALS)
log.context(otelCtx).info("msg")

// Attach a metric (fires before level check)
log.metric(counter).info("msg", { cluster })

// Error: error param is positional (matches Go)
log.error("reserve failed", err, { cluster })
```

Levels: `debug | info | warn | error | none`. We add `warn` (pino has it,
Go's telemetry doesn't) — it's a free win and Node users expect it.

---

## Testing strategy

Mirrors `dio/logging`:

- **Unit tests**: vitest. `pino` writes to a `stream.Writable` collector;
  assertions on parsed JSON lines.
- **Metric tests**: `@opentelemetry/sdk-metrics` with
  `InMemoryMetricExporter` + `PeriodicExportingMetricReader` forced-flush.
  Direct analogue to `MemSink.Snapshot()`.
- **Trace correlation**: `@opentelemetry/sdk-trace-base` with an
  `InMemorySpanExporter`; start a span, log inside, assert `trace_id` field.
- **ALS test**: spawn parallel async chains, assert no attr cross-talk.
- **Level-bypass regression**: set level=error, call `.metric(c).info()`,
  assert log absent + counter incremented.

CI: GitHub Actions, Node 20 + 22, lint (eslint flat config + prettier),
typecheck, test, build. License Apache-2.0 to match Go sibling.

---

## Build & distribution

- TypeScript source, ESM-first, CJS shipped via tsup dual build.
- `exports` map with types-first conditional exports.
- Node ≥ 20 (AsyncLocalStorage is stable, OTel SDK supports it).
- Package: `@tetratelabs/logging`.
- Repo: `github.com/dio/logging-node` (Apache-2.0).

Peer deps (kept minimal):

```jsonc
"peerDependencies": {
  "@opentelemetry/api": ">=1.9 <2"
}
"dependencies": {
  "pino": "^9"
}
```

OTel SDK is **not** a runtime dep — users wire their own MeterProvider /
TracerProvider, same as Go.

---

## Non-goals (for v0)

- No log shipping / transport plumbing (use pino transports).
- No GCP-specific sink (the Go `gcp/` package); add later if a service needs it.
- No HTTP middleware helpers (services have their own framework idioms).
- No browser build — Node-only. AsyncLocalStorage isn't a thing in browsers.

---

## Locked decisions

1. **Package**: `@tetratelabs/logging`
2. **Repo**: `github.com/dio/logging-node`
3. **License**: Apache-2.0
4. **Levels**: pino strings — `"debug" | "info" | "warn" | "error" | "none"`.
   (`"trace"` and `"fatal"` are pino-supported but not exposed by our facade;
   we keep parity with Go's level set + `warn`.)
5. **Error signature**: positional — `log.error(msg, err, attrs?)`. `err`
   is required (may be `null` if truly absent).
6. **`@vercel/otel`**: documented in README, **not** a peer dep. Users may
   wire raw `NodeSDK` instead.
