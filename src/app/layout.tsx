import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "If TV Station",
  description: "Automated parallel world video studio for story generation, editing, and publishing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <div style={{ background: '#0a0e27', padding: '8px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', position: 'sticky', top: 0, zIndex: 9999 }}>
          <a href="https://studio.milkcat.org/" target="_top" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '999px', background: 'rgba(239, 68, 68, 0.25)', border: '1px solid rgba(239, 68, 68, 0.45)', color: '#fff', textDecoration: 'none', fontSize: '12px', fontWeight: 700 }}>
            <span>⬅️</span>
            <span>返回 Milkcat 官網</span>
          </a>
          <span style={{ color: '#94a3b8', fontSize: '12px' }}>🎞️ If TV Station · AI 影像電視台</span>
        </div>
        {children}
      </body>
    </html>
  );
}
