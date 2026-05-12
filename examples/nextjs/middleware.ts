import { NextResponse } from "next/server"
import { withLogAttrs, log } from "@tetratelabs/logging"

export const config = { matcher: "/api/:path*" }

export default async function middleware(req: Request) {
  // Use withLogAttrs (not withAttrs) for request_id / path. These are
  // unbounded fields — they belong on log records but NEVER on counter
  // labels. For bounded labels you want on both logs AND metrics (e.g.
  // tenant, region), use withAttrs inside this callback.
  return await withLogAttrs(
    {
      request_id: req.headers.get("x-request-id") ?? crypto.randomUUID(),
      path: new URL(req.url).pathname,
    },
    async () => {
      log.info("edge: incoming")
      return NextResponse.next()
    },
  )
}
