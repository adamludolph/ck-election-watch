import type { Metadata } from "next";
import Link from "next/link";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Municipal Election Explorer",
  description:
    "A neutral, evidence-first record of what municipal candidates have said publicly.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="site-header">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden="true">
              EE
            </span>
            <span>Election Explorer</span>
          </Link>
          <span className="header-note">Evidence, not endorsements</span>
        </header>
        {children}
        <footer className="site-footer">
          <p>
            This local demonstration uses synthetic candidate and campaign
            content. It does not describe a real person.
          </p>
        </footer>
      </body>
    </html>
  );
}
