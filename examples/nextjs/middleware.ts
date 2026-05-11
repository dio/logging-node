import { NextResponse } from "next/server"
import { withAttrs, log } from "@tetratelabs/logging"

export const config = { matcher: "/api/:path*" }

export default async function middleware(req: Request) {
  return await withAttrs(
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
