import type { Metadata } from "next";
import { Source_Serif_4, IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const displaySerif = Source_Serif_4({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700"],
});

const dataMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const uiSans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
