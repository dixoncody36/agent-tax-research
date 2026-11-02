import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = { title: "Agent Tax Research — Globe & Review" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">AGENT TAX RESEARCH</div>
          <nav>
            <Link href="/">Globe</Link>
            <Link href="/review">Human Review Queue</Link>
          </nav>
          <div className="tagline">agent-first · human-last</div>
        </header>
        {children}
      </body>
    </html>
  );
}
