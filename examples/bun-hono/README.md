# bun-hono example

Hono on Bun using `@tetratelabs/logging` with the Hono middleware adapter.

## Run

```bash
# From repo root:
pnpm install               # installs workspace deps (incl. @tetratelabs/logging)
cd examples/bun-hono
bun install                # Bun reads workspace symlink
bun dev                    # --hot reload, port 3457
```

Then:

```bash
curl http://localhost:3457/         # logs "root hit" + "request handled"
curl http://localhost:3457/boom     # logs "request failed" with err
```

Look at stdout — every line is a JSON log entry with `request_id`, `method`,
`path`, `status`, `duration_ms`.

## What this shows

- `loggingMiddleware()` from `@tetratelabs/logging/hono` wires per-request
  attrs into the OTel context (via `withAttrs`).
- The global logger picks up those attrs anywhere in the request chain.
- pino runs cleanly under Bun (no Edge-runtime fallback needed).
