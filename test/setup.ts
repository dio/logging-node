import { context } from "@opentelemetry/api"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"

// Register AsyncHooksContextManager so context.with() actually propagates
// This is needed for proper context isolation in tests
const mgr = new AsyncHooksContextManager()
mgr.enable()
context.setGlobalContextManager(mgr)
