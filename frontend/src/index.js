import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { installGlobalLogging } from "./lib/debugLog";

installGlobalLogging();

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <ToastProvider><App /></ToastProvider>
  </React.StrictMode>
);
