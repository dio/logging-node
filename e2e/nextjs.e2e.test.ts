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

const exampleDir = join(process.cwd(), "examples/nextjs")
const port = process.env.NEXTJS_E2E_PORT ?? "3456"
const baseUrl = `http://localhost:${port}`

const ready =
  hasCommand("pnpm") &&
  existsSync(exampleDir) &&
  existsSync(join(exampleDir, "node_modules", "next"))

describe.skipIf(!ready)("Next.js example e2e", () => {
  let proc: ChildProcess
  let cap: Capture

  beforeAll(async () => {
    proc = spawnExample("pnpm", ["dev"], exampleDir, { PORT: port, LOG_LEVEL: "info" })
    cap = captureProcess(proc)
    await waitForReady(`${baseUrl}/api/health`, 90_000)
  }, 90_000)

  afterAll(async () => {
    await killProc(proc)
  })

  it("/api/hello logs with request_id and route attrs", async () => {
    const res = await fetch(`${baseUrl}/api/hello`, {
      headers: { "x-request-id": "e2e-1" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; request_id: string }
    expect(body.ok).toBe(true)
    expect(body.request_id).toBe("e2e-1")

    // Give pino a tick.
    await new Promise((r) => setTimeout(r, 250))

    const entries = cap.jsonLines()
    const hello = entries.find((e) => e.msg === "hello called" || e.message === "hello called")
    expect(hello, `no "hello called" entry found in ${entries.length} lines`).toBeDefined()
    expect(hello!.request_id).toBe("e2e-1")
    expect(hello!.route).toBe("/api/hello")
  })

  it("RSC page logs with tenant attrs", async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 250))

    const entries = cap.jsonLines()
    const home = entries.find(
      (e) => e.msg === "rendering home page" || e.message === "rendering home page",
    )
    expect(home).toBeDefined()
    expect(home!.tenant).toBe("demo")
    expect(home!.page).toBe("home")
  })
})
