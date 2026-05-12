import { Hono } from "hono"
import { loggingMiddleware } from "@tetratelabs/logging/hono"
import { createLogger, setGlobalLogger, log } from "@tetratelabs/logging"

setGlobalLogger(
  createLogger({
    name: "bun-hono-example",
    level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error" | "none") ?? "info",
  }),
)

const app = new Hono()

app.use(loggingMiddleware())

app.get("/health", (c) => c.text("ok"))

app.get("/", (c) => {
  log.info("root hit")
  return c.text("hello")
})

app.get("/boom", () => {
  throw new Error("intentional")
})

const port = Number(process.env.PORT ?? 3457)

// Bun's default export is { port, fetch }; this is the canonical Bun.serve shape.
export default { port, fetch: app.fetch }
