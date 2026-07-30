import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ViewerApp } from "./ViewerApp";
import "./viewer.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewerApp />
  </StrictMode>,
);
