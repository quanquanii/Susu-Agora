// Buffer / process / global polyfills are injected by vite-plugin-node-polyfills
// (see vite.config.ts). Solana SDKs require them.

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
