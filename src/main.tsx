import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
// v0.11.0 B6-2：让「自定义 CSS」设置真正生效。
// 此前该设置有 UI、有 store、有 Rust 字段，但全仓无任何样式注入点
// （grep createElement("style") / adoptedStyleSheets / insertRule 零命中）
// → 用户写完 CSS 点「保存设置」毫无反应，属典型欺骗性 UI。
// 本模块负责幂等注入 + 非法 CSS 兜底 + 跨窗口同步。
import { initCustomCssInjection } from "./utils/customCss";
// KaTeX 样式通过 index.html 中的 <link> 引入 /vendor/katex/katex.min.css
// 避免 Vite 将字体文件重复打包到 dist/assets/（节省约 3MB）

// 启动即注入（persist rehydrate 完成后 store 订阅会自动跟进变更）
initCustomCssInjection();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
