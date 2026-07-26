import Link from "next/link";

export default function NotFound() {
  return (
    <main className="not-found">
      <div className="eyebrow">404 · Record not found</div>
      <h1>That candidacy is not in this evidence record.</h1>
      <p>
        The local demonstration includes one synthetic candidacy and does not
        search live election data.
      </p>
      <Link className="primary-button" href="/">
        Return home
      </Link>
    </main>
  );
}
