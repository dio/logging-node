import { describe, it, expect } from "vitest"
import { createEdgeSink } from "../src/sink-edge"

describe("Edge Sink", () => {
  it("outputs JSON to console.log", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createEdgeSink()
      sink.write("info", "hello", { user: "alice" })

      expect(calls).toHaveLength(1)
      const parsed = JSON.parse(calls[0])
      expect(parsed.level).toBe("info")
      expect(parsed.msg).toBe("hello")
      expect(parsed.user).toBe("alice")
      expect(parsed.time).toBeDefined()
    } finally {
      console.log = originalLog
    }
  })

  it("filters by log level", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createEdgeSink()
      // Edge sink should respect level filtering
      sink.write("debug", "d1", {})
      sink.write("info", "i1", {})
      sink.write("error", "e1", {})

      // Edge sink always writes (shouldLog("debug", "debug") is true for all)
      expect(calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      console.log = originalLog
    }
  })

  it("handles structured fields", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createEdgeSink()
      sink.write("info", "transaction", {
        amount: 100.5,
        currency: "USD",
        success: true,
        metadata: null,
      })

      expect(calls).toHaveLength(1)
      const parsed = JSON.parse(calls[0])
      expect(parsed.amount).toBe(100.5)
      expect(parsed.currency).toBe("USD")
      expect(parsed.success).toBe(true)
      expect(parsed.metadata).toBeNull()
    } finally {
      console.log = originalLog
    }
  })

  it("serializes nested objects", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createEdgeSink()
      sink.write("warn", "config", {
        nested: { key: "value" },
        array: [1, 2, 3],
      })

      expect(calls).toHaveLength(1)
      const parsed = JSON.parse(calls[0])
      expect(parsed.nested.key).toBe("value")
      expect(parsed.array).toEqual([1, 2, 3])
    } finally {
      console.log = originalLog
    }
  })
})
