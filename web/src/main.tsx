import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./app.css";
import { applyStoredUiFontSize } from "./state/ui-font.ts";

applyStoredUiFontSize();

createRoot(document.getElementById("root")!).render(<App />);
