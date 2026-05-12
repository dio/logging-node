export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerOTel } = await import("@vercel/otel")
    registerOTel({ serviceName: "nextjs-example" })
    const { createLogger, setGlobalLogger } = await import("@tetratelabs/logging")
    setGlobalLogger(
      createLogger({ name: "nextjs-example", level: process.env.LOG_LEVEL ?? "info" }),
    )
  }
}
