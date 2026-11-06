import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "WALLET OS", template: "%s · WALLET OS" },
  description: "Sistema operacional pessoal: finanças, agenda, e-mails e tarefas.",
  applicationName: "WALLET OS",
  appleWebApp: {
    capable: true,
    title: "WALLET OS",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="min-h-dvh bg-ink font-sans text-fg antialiased">
        {children}
      </body>
    </html>
  );
}
