// Tests for GCP project auto-detection from the metadata server (v0.3.0).
//
// We stub global fetch to simulate metadata server responses without
// hitting the real network. The cache is reset before each test via
// the internal _resetMetadataProjectCacheForTests helper.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createGcpSink, _resetMetadataProjectCacheForTests } from "../src/gcp"

let captured: string[]
let originalLog: typeof console.log
let originalFetch: typeof globalThis.fetch
let originalEnv: { project?: string; gcloud?: string }

beforeEach(() => {
  captured = []
  originalLog = console.log
  console.log = (s: string) => captured.push(s)
  originalFetch = globalThis.fetch
  originalEnv = {
    project: process.env.GOOGLE_CLOUD_PROJECT,
    gcloud: process.env.GCLOUD_PROJECT,
  }
  delete process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.GCLOUD_PROJECT
  _resetMetadataProjectCacheForTests()
})

afterEach(() => {
  console.log = originalLog
  globalThis.fetch = originalFetch
  if (originalEnv.project !== undefined) {
    process.env.GOOGLE_CLOUD_PROJECT = originalEnv.project
  }
  if (originalEnv.gcloud !== undefined) {
    process.env.GCLOUD_PROJECT = originalEnv.gcloud
  }
})

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("GCP project auto-detection", () => {
  it("uses metadata server when no explicit project and no env vars", async () => {
    let metadataCalls = 0
    globalThis.fetch = vi.fn(async (url) => {
      metadataCalls++
      expect(String(url)).toContain("metadata.google.internal")
      return new Response("my-detected-project", { status: 200 })
    }) as typeof fetch

    const sink = createGcpSink({ name: "t" })
    // Wait for async detection to settle.
    await flushPromises()
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBe("projects/my-detected-project/traces/abc123")
    expect(metadataCalls).toBe(1)
  })

  it("explicit project skips metadata detection entirely", async () => {
    let metadataCalls = 0
    globalThis.fetch = vi.fn(async () => {
      metadataCalls++
      return new Response("should-not-be-used", { status: 200 })
    }) as typeof fetch

    const sink = createGcpSink({ name: "t", project: "explicit-proj" })
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBe("projects/explicit-proj/traces/abc123")
    expect(metadataCalls).toBe(0)
  })

  it("GOOGLE_CLOUD_PROJECT env skips metadata detection", async () => {
    let metadataCalls = 0
    globalThis.fetch = vi.fn(async () => {
      metadataCalls++
      return new Response("should-not-be-used", { status: 200 })
    }) as typeof fetch

    process.env.GOOGLE_CLOUD_PROJECT = "env-proj"
    const sink = createGcpSink({ name: "t" })
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBe("projects/env-proj/traces/abc123")
    expect(metadataCalls).toBe(0)
  })

  it("projectAutoDetect:false disables metadata fetch", async () => {
    let metadataCalls = 0
    globalThis.fetch = vi.fn(async () => {
      metadataCalls++
      return new Response("nope", { status: 200 })
    }) as typeof fetch

    const sink = createGcpSink({ name: "t", projectAutoDetect: false })
    await flushPromises()
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    // No project resolved means no trace prefix.
    expect(entry["logging.googleapis.com/trace"]).toBeUndefined()
    expect(metadataCalls).toBe(0)
  })

  it("non-2xx metadata response leaves project undefined", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("forbidden", { status: 403 })
    }) as typeof fetch

    const sink = createGcpSink({ name: "t" })
    await flushPromises()
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBeUndefined()
  })

  it("network error (non-GCP env) leaves project undefined and caches failure", async () => {
    let metadataCalls = 0
    globalThis.fetch = vi.fn(async () => {
      metadataCalls++
      throw new Error("ENOTFOUND metadata.google.internal")
    }) as typeof fetch

    const sink = createGcpSink({ name: "t" })
    await flushPromises()
    await flushPromises()

    sink.write("info", "first", { trace_id: "abc" })
    sink.write("info", "second", { trace_id: "def" })
    sink.write("info", "third", { trace_id: "ghi" })

    // Failure cached: only one fetch attempt despite three log calls.
    expect(metadataCalls).toBe(1)
    for (const line of captured) {
      const e = JSON.parse(line)
      expect(e["logging.googleapis.com/trace"]).toBeUndefined()
    }
  })

  it("uses Metadata-Flavor header per GCP requirement", async () => {
    let receivedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      receivedHeaders = new Headers(init?.headers)
      return new Response("h-proj", { status: 200 })
    }) as typeof fetch

    createGcpSink({ name: "t" })
    await flushPromises()
    await flushPromises()

    expect(receivedHeaders?.get("metadata-flavor")).toBe("Google")
  })
})
