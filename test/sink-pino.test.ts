import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createPinoSink } from "../src/sink-pino"
import { createLogger } from "../src/index"
import { parseLevel } from "../src/levels"

// pino writes to process.stdout by default. Intercept it for the duration
// of each test so we can assert on which records pino actually emitted.
let stdoutLines: string[]
let originalWrite: typeof process.stdout.write

beforeEach(() => {
  stdoutLines = []
  originalWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (chunk: any) => {
    stdoutLines.push(String(chunk))
    return true
  }
})

afterEach(() => {
  process.stdout.write = originalWrite
})

function parsedLines(): any[] {
  return stdoutLines
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe("createPinoSink — level wiring", () => {
  it("emits debug records when LoggerOptions.level is debug", () => {
    const sink = createPinoSink({ level: "debug" })
    sink.write("debug", "d", {})
    sink.write("info", "i", {})

    expect(parsedLines().map((l) => l.msg)).toEqual(["d", "i"])
  })

  it("regression: createLogger({ level: 'debug' }) emits debug records", () => {
    // Before the fix, pino defaulted to level=info inside the sink, so
    // debug records were dropped even though the wrapper allowed them.
    const logger = createLogger({ level: "debug" })
    logger.debug("debug-visible")
    logger.info("info-visible")

    const msgs = parsedLines().map((l) => l.msg)
    expect(msgs).toContain("debug-visible")
    expect(msgs).toContain("info-visible")
  })

  it("explicit opts.pino.level wins over wrapper level", () => {
    const sink = createPinoSink({ level: "debug", pino: { level: "warn" } })
    sink.write("debug", "drop-me", {})
    sink.write("warn", "keep-me", {})

    const msgs = parsedLines().map((l) => l.msg)
    expect(msgs).not.toContain("drop-me")
    expect(msgs).toContain("keep-me")
  })

  it("wrapper level=none silences pino entirely", () => {
    const sink = createPinoSink({ level: "none" })
    sink.write("error", "should-not-appear", {})
    expect(parsedLines()).toEqual([])
  })
})

describe("parseLevel — unknown LOG_LEVEL fallback", () => {
  it("unknown values fall back to info, not silence", () => {
    expect(parseLevel("verbose")).toBe("info")
    expect(parseLevel("loud")).toBe("info")
    expect(parseLevel("")).toBe("info")
    expect(parseLevel(undefined)).toBe("info")
  })

  it("pino aliases are accepted", () => {
    expect(parseLevel("trace")).toBe("debug")
    expect(parseLevel("TRACE")).toBe("debug")
    expect(parseLevel("fatal")).toBe("error")
    expect(parseLevel("FATAL")).toBe("error")
  })

  it("known values are preserved", () => {
    expect(parseLevel("debug")).toBe("debug")
    expect(parseLevel("info")).toBe("info")
    expect(parseLevel("warn")).toBe("warn")
    expect(parseLevel("error")).toBe("error")
    expect(parseLevel("none")).toBe("none")
  })
})
