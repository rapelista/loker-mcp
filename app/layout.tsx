export const metadata = { title: "Loker MCP", robots: { index: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 40 }}>{children}</body>
    </html>
  );
}
