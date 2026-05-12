// Susurration web app — route dispatcher.
//
// Routes:
//   /     → LandingPage (cream/ink brand, 3 copy boxes = onboarding surface)
//   /docs → DocsPage    (cream/ink, sidebar nav)
//
// D14: web onboarding flow removed entirely.
// Reason: Phantom keypair lives in the browser extension; CLI keypair lives
// in ~/.susu/config.json. They are different keys. A web "register username"
// step would force the CLI user to register again with a different identity
// — net negative UX. The 3 landing CopyBoxes (CLI / MCP / AGENT DOC) are
// the complete onboarding surface; users go straight from copy → terminal.
//
// Tagline framing: NARROW (trading-focused) per BETA scope. To pivot to
// BROAD (general agent collaboration), edit TAGLINE in LandingPage.tsx.

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "./i18n.tsx";
import { LandingPage } from "./LandingPage.tsx";
import { DocsPage } from "./DocsPage.tsx";
import { DashboardPage } from "./DashboardPage.tsx";

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="*" element={<LandingPage />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}
