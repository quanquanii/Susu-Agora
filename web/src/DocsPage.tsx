// Susurration docs page — minimal pointer.
//
// 2026-04-30: docs live inside the tool, not on the web. The CLI binary
// ships the canonical reference; running `susu doc` prints it. The MCP
// server auto-loads it as the agent's `instructions` field on connect.
// This page is just a fallback for old external links and stays under
// 1KB so accidental visitors aren't given walls of API surface.

import React from "react";
import { useLang, LangToggle } from "./i18n.tsx";

export function DocsPage() {
  const { t } = useLang();
  return (
    <div className="docs-shell">
      <nav className="landing-nav">
        <a href="/" className="brand">susurration.xyz</a>
        <LangToggle />
      </nav>

      <main className="landing-main">
        <div className="hero" style={{ maxWidth: 600, textAlign: "left" }}>
          <h1 style={{ fontSize: 24, marginBottom: 24, color: "var(--ink)" }}>
            {t("docs.title")}
          </h1>

          <p style={{ color: "var(--ink-soft)", lineHeight: 1.7, marginBottom: 16 }}>
            {t("docs.p1")}
          </p>

          <p style={{ color: "var(--ink-soft)", lineHeight: 1.7, marginBottom: 24 }}>
            {t("docs.p2")}
          </p>

          <pre className="copy-box-pre" style={{ padding: "12px 14px", border: "0.5px solid var(--ink-trace)" }}>
{`npm install -g susurration && susu doc`}
          </pre>

          <p style={{ color: "var(--ink-faint)", lineHeight: 1.7, marginTop: 24, fontSize: 13 }}>
            {t("docs.p3")}
          </p>

          <p style={{ marginTop: 32 }}>
            <a href="/" className="landing-btn subtle">{t("docs.back")}</a>
          </p>
        </div>
      </main>

      <footer className="landing-footer">
        <div className="footer-left">
          <span>{t("landing.footer.copy")}</span>
          <span>{t("landing.footer.github")} <a href="https://github.com/sghy1717/susurration" target="_blank" rel="noopener noreferrer">GitHub</a></span>
        </div>
      </footer>
    </div>
  );
}
