import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import {
  captureProcess,
  killProc,
  spawnExample,
  waitForReady,
  hasCommand,
  type Capture,
} from "./helpers.js"

const exampleDir = join(process.cwd(), "examples/bun-hono")
const port = process.env.BUN_E2E_PORT ?? "3457"
const baseUrl = `http://localhost:${port}`

const ready = hasCommand("bun") && existsSync(exampleDir)

describe.skipIf(!ready)("Bun+Hono example e2e", () => {
  let proc: ChildProcess
  let cap: Capture

  beforeAll(async () => {
    proc = spawnExample("bun", ["src/index.ts"], exampleDir, {
      PORT: port,
      LOG_LEVEL: "info",
    })
    cap = captureProcess(proc)
    await waitForReady(`${baseUrl}/health`, 30_000)
  }, 30_000)

  afterAll(async () => {
    await killProc(proc)
  })

  it("GET / emits request_handled log with status 200", async () => {
    const res = await fetch(baseUrl + "/")
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 100))

    const handled = cap
      .jsonLines()
      .find(
        (e) => (e.msg === "request handled" || e.message === "request handled") && e.path === "/",
      )
    expect(handled).toBeDefined()
    expect(handled!.method).toBe("GET")
    expect(handled!.status).toBe(200)
    expect(typeof handled!.duration_ms).toBe("number")
    expect(typeof handled!.request_id).toBe("string")
  })

  it("GET /boom emits request_failed error log", async () => {
    // /boom throws; Hono returns 500 by default.
    const res = await fetch(baseUrl + "/boom")
    expect(res.status).toBe(500)

    await new Promise((r) => setTimeout(r, 100))

    const failed = cap
      .jsonLines()
      .find(
        (e) => (e.msg === "request failed" || e.message === "request failed") && e.path === "/boom",
      )
    expect(failed, `no "request failed" entry for /boom`).toBeDefined()
    const errField = failed!.err as { message?: string } | undefined
    expect(errField?.message).toBe("intentional")
  })
})
