import type { Metadata } from "next";
import { Anton, Geist, JetBrains_Mono } from "next/font/google";

import { SolanaProviders } from "@/components/wallet/wallet-provider";
import { SiteNav } from "@/components/layout/site-nav";
import { SiteFooter } from "@/components/layout/site-footer";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

// Poster display face — self-hosted at build (CSP-safe, no runtime CDN).
// Third type role alongside Geist (body/UI) and JetBrains Mono (data); used
// ONLY for the sports-poster marketing surfaces, never functional UI.
const anton = Anton({
  variable: "--font-anton",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Gorilla Markets — Trustless agent-settled prediction markets",
  description:
    "Autonomous agents bet on live sports; every outcome settles by the data provider's own on-chain Merkle proof. The program never calls the result.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${jetbrainsMono.variable} ${anton.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <SolanaProviders>
          <div className="app-backdrop relative flex min-h-dvh flex-col">
            <div className="grid-overlay pointer-events-none absolute inset-0 -z-10" />
            <SiteNav />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </div>
        </SolanaProviders>
      </body>
    </html>
  );
}
