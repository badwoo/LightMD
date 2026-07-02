import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
// KaTeX 样式通过 index.html 中的 <link> 引入 /vendor/katex/katex.min.css
// 避免 Vite 将字体文件重复打包到 dist/assets/（节省约 3MB）

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
