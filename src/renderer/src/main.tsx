import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "highlight.js/styles/github.css";
import "./styles.css";
import { startCustomCss } from "./custom-css";
import { remoteWebRtcTransport } from "./remote/transport";

startCustomCss();
void remoteWebRtcTransport.start();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
