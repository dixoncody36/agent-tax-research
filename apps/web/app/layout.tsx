import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = { title: "A&M Tax — Agent Tax Research" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          {/* Approved A&M Tax white logo (decision 028): unaltered, ~2.71:1 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo" src="/amtax-white.png" alt="Alvarez & Marsal Tax" width={92} height={34} />
          <div className="product">
            <span className="product-name">Agent Tax Research</span>
            <span className="tagline">Leadership.Action.Results.</span>
          </div>
          <nav>
            <Link href="/">Globe</Link>
            <Link href="/explore">Explore</Link>
            <Link href="/review">Human Review Queue</Link>
          </nav>
          <span className="draft-tag" title="Draft — not a final client deliverable">Draft</span>
        </header>
        {children}
      </body>
    </html>
  );
}
