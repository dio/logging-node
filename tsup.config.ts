import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    external: ["pino"],
  },
  {
    entry: { edge: "src/edge.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node20",
    external: ["pino"],
  },
  {
    entry: { gcp: "src/gcp.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node20",
    external: ["pino"],
  },
  {
    entry: { hono: "src/hono.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node20",
    external: ["pino", "hono"],
  },
])
