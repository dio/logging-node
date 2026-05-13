// Node entry point: includes pino sink
export type { Level, Attrs, Logger, LoggerOptions, Metric } from "./types.js"
export {
  getAttrs,
  setAttrsOnContext,
  withAttrs,
  getLogAttrs,
  setLogAttrsOnContext,
  withLogAttrs,
  getOperation,
  setOperationOnContext,
} from "./context.js"
export type { OperationInfo } from "./context.js"
export { getGlobalLogger, setGlobalLogger, log } from "./global.js"
export { parseLevel } from "./levels.js"

import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { LoggerImpl } from "./logger.js"
import type { LoggerOptions, Logger } from "./types.js"
import { createPinoSink } from "./sink-pino.js"

// Install AsyncLocalStorageContextManager once at module load. We use the
// ALS-based manager (not AsyncHooksContextManager) because:
//   - It works on Bun (Bun implements AsyncLocalStorage but NOT
//     async_hooks.createHook — which the AsyncHooks variant requires).
//   - It works on Node 14+ with the same propagation semantics.
// If a framework (@vercel/otel, NodeSDK) registers its own manager first,
// setGlobalContextManager returns false silently — no conflict.
const g = globalThis as { __tetratelabs_ctxmgr_installed?: boolean }
if (!g.__tetratelabs_ctxmgr_installed) {
  try {
    const mgr = new AsyncLocalStorageContextManager()
    mgr.enable()
    context.setGlobalContextManager(mgr)
  } catch {
    /* already installed by someone else */
  }
  g.__tetratelabs_ctxmgr_installed = true
}

export function createLogger(opts?: LoggerOptions): Logger {
  const sink = createPinoSink(opts)
  return new LoggerImpl(sink, opts)
}
