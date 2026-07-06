import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "./providers";

// Self-hosted (next/font/local) instead of next/font/google: the latter
// needs a network fetch from Google Fonts at build time, which isn't
// reliable in every environment this project builds in. Files below are
// the same latin-subset woff2s next/font/google would have fetched itself.
const displaySerif = localFont({
  src: "./fonts/SourceSerif4-Variable.woff2",
  variable: "--font-display",
  weight: "600 700",
});

const dataMono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexMono-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexMono-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-mono",
});

const uiSans = localFont({
  src: "./fonts/Inter-Variable.woff2",
  variable: "--font-sans",
  weight: "400 600",
});

export const metadata: Metadata = {
  title: "Redoubt — Confidential Cover Pool",
  description:
    "Confidential cover pools on Zama FHEVM — encrypted coverage, encrypted premiums, encrypted payouts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The dossier/control-room aesthetic is a deliberate, single-theme
      // choice (see claude.md's frontend section) — not an oversight of
      // light-mode support.
      className={`dark ${displaySerif.variable} ${dataMono.variable} ${uiSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
