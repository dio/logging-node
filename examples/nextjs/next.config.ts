import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  serverExternalPackages: ["@tetratelabs/logging", "pino", "thread-stream", "pino-pretty"],
}

export default nextConfig
