import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { StandaloneChangelog } from "./components/StandaloneChangelog";
import { StandaloneDevLog } from "./components/StandaloneDevLog";
import { StandalonePreview } from "./components/StandalonePreview";
import "highlight.js/styles/github.css";
import "./styles.css";
import { remoteWebRtcTransport } from "./remote/transport";

void remoteWebRtcTransport.start();

// Standalone windows load the same renderer with a hash and render only that
// view: #preview=<absPath> (popped-out file), #dev-release-log, #changelog.
const previewHash = window.location.hash.match(/^#preview=(.+)$/);
ReactDOM.createRoot(document.getElementById("root")!).render(
  previewHash ? (
    <StandalonePreview path={decodeURIComponent(previewHash[1])} />
  ) : window.location.hash === "#dev-release-log" ? (
    <StandaloneDevLog />
  ) : window.location.hash === "#changelog" ? (
    <StandaloneChangelog />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
