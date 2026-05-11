import { withAttrs, log } from "@tetratelabs/logging"

export default async function Page() {
  return await withAttrs({ tenant: "demo", page: "home" }, async () => {
    log.info("rendering home page")
    return (
      <main>
        <h1>Hello</h1>
        <p>Check server logs.</p>
      </main>
    )
  })
}
