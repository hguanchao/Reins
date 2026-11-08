import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./app.css";
import { applyPreferences, readPreferences } from "./state/preferences.ts";
import { applyStoredUiFontSize } from "./state/ui-font.ts";

// 首帧之前落好本机观感偏好，避免减少动效/连字开关在刷新后要等设置页打开才生效
applyStoredUiFontSize();
applyPreferences(readPreferences());

createRoot(document.getElementById("root")!).render(<App />);
