import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./workspace/app";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("工作区挂载点缺失");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
