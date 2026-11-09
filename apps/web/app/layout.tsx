import type { ReactNode } from "react";
import Link from "next/link";
import localFont from "next/font/local";
import "./globals.css";

// Ascension design system fonts, vendored from factory packages/ui/src/fonts (OFL).
const sans = localFont({ src: "./fonts/inter-latin.woff2", variable: "--font-sans", weight: "100 900", display: "swap" });
const heading = localFont({ src: "./fonts/roboto-slab-latin.woff2", variable: "--font-heading", weight: "100 900", display: "swap" });
const mono = localFont({ src: "./fonts/geist-mono-latin.woff2", variable: "--font-mono", weight: "100 900", display: "swap" });

export const metadata = { title: "Ascension — Agent Tax Research" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${heading.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          {/* Ascension wordmark (factory packages/ui logos/wordmark-red-dark.svg), 4.5:1 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo" src="/ascension-wordmark.svg" alt="Ascension" width={153} height={34} />
          <div className="product">
            <span className="product-name">Agent Tax Research</span>
            <span className="tagline">Agent-first tax research, human-approved</span>
          </div>
          <nav>
            <Link href="/">Globe</Link>
            <Link href="/explore">Explore</Link>
            <Link href="/agents">Agents</Link>
            <Link href="/benchmarks">Benchmarks</Link>
            <Link href="/downloads">Downloads</Link>
            <Link href="/ask">Ask</Link>
            <Link href="/review">Human Review Queue</Link>
          </nav>
          <span className="draft-tag" title="Draft — not a final client deliverable">Draft</span>
        </header>
        {children}
      </body>
    </html>
  );
}
