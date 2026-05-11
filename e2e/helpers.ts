import { spawn, type ChildProcess, execSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

export type Capture = { lines: string[]; jsonLines: () => Record<string, unknown>[] }

export function captureProcess(proc: ChildProcess): Capture {
  const lines: string[] = []
  const onData = (b: Buffer | string) =>
    b
      .toString()
      .split("\n")
      .forEach((l) => {
        if (l) lines.push(l)
      })
  proc.stdout?.on("data", onData)
  proc.stderr?.on("data", onData)
  return {
    lines,
    jsonLines: () =>
      lines
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((x): x is Record<string, unknown> => x !== null),
  }
}

export async function waitForReady(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not ready */
    }
    await sleep(500)
  }
  throw new Error(`Server at ${url} did not become ready in ${timeoutMs}ms`)
}

export function killProc(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.killed) return Promise.resolve()
  return new Promise((resolve) => {
    proc.once("exit", () => resolve())
    proc.kill("SIGTERM")
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL")
      resolve()
    }, 5000)
  })
}

export function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function spawnExample(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  return spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

export { spawn }
