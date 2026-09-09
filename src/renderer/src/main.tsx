import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { StandalonePreview } from "./components/StandalonePreview";
import "highlight.js/styles/github.css";
import "./styles.css";
import { remoteWebRtcTransport } from "./remote/transport";

void remoteWebRtcTransport.start();

// A preview popped out into its own window loads the same renderer with a
// #preview=<absPath> hash and renders only that file.
const previewHash = window.location.hash.match(/^#preview=(.+)$/);
ReactDOM.createRoot(document.getElementById("root")!).render(
  previewHash ? (
    <StandalonePreview path={decodeURIComponent(previewHash[1])} />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
