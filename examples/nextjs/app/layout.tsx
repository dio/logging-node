import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Logging Example",
  description: "tetratelabs/logging example",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
