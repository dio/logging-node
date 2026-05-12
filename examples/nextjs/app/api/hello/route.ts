import { withAttrs, log } from "@tetratelabs/logging"
import { NextResponse } from "next/server"

export async function GET(req: Request) {
  const rid = req.headers.get("x-request-id") ?? crypto.randomUUID()
  return await withAttrs({ request_id: rid, route: "/api/hello" }, async () => {
    log.info("hello called")
    return NextResponse.json({ ok: true, request_id: rid })
  })
}
