import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="hero">
        <div className="eyebrow">Chatham-Kent · 2026 municipal election</div>
        <h1>See what a candidate actually said.</h1>
        <p className="hero-copy">
          Election Explorer turns public campaign material into a traceable
          record. Every published statement keeps the exact quote, captured
          source, and snapshot fingerprint beside it.
        </p>
        <div className="hero-actions">
          <Link className="primary-button" href="/candidates/demo-candidate">
            Open the evidence demo
          </Link>
          <a className="text-link" href="#standard">
            Read the evidence standard
          </a>
        </div>
      </section>

      <section className="principles" id="standard" aria-labelledby="standard-title">
        <div>
          <div className="eyebrow">Publication standard</div>
          <h2 id="standard-title">Incomplete by design. Precise by default.</h2>
        </div>
        <div className="principle-grid">
          <article>
            <span className="principle-number">01</span>
            <h3>Candidate words only</h3>
            <p>
              Journalist interpretations and third-party comments are never
              presented as a candidate position.
            </p>
          </article>
          <article>
            <span className="principle-number">02</span>
            <h3>Every claim has a trace</h3>
            <p>
              A statement links to an exact quote, normalized source block,
              capture time, and immutable content hash.
            </p>
          </article>
          <article>
            <span className="principle-number">03</span>
            <h3>Abstention is success</h3>
            <p>
              If the evidence is ambiguous or incomplete, the system says so
              instead of filling the gap with an inference.
            </p>
          </article>
        </div>
      </section>
    </main>
  );
}
