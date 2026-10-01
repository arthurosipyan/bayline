import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OperatorScreen } from "./OperatorScreen";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root missing");

createRoot(root).render(
  <StrictMode>
    <OperatorScreen />
  </StrictMode>,
);
