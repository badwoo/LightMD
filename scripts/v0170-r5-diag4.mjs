import fs from "node:fs";
import path from "node:path";
import { runProbe, sleep } from "./_lib/probe-harness.mjs";
const ROOT="D:\\AI\\markdown view\\lightmd";
const READ=`const c=document.querySelector(".cm-content");const v=c&&c.cmTile&&c.cmTile.view;return v&&v.state?v.state.doc.toString():(document.querySelector("textarea.source-editor")?.value??"");`;
const doc=fs.readFileSync("D:\\10254\\桌面\\md测试.md","utf8");
const mask=(s)=>s.replace(/data:image[^)]*/g,"<B64>");
await runProbe({name:"v0170-r5-diag4",doc,docTitle:"新文档",viewMode:"edit"},async(ui)=>{
  const t0=await ui.ev(READ);
  ui.log(`[D4] 初始 len=${t0.length}  含\\sum=${t0.includes("\\sum")}  含\\\\sum=${t0.includes("\\\\sum")}`);
  // 切阅读
  await ui.command("view.preview"); await sleep(3000);
  const pm=await ui.ev(`const p=document.querySelector(".editor-container .ProseMirror")||document.querySelector(".ProseMirror");return p?(p.textContent||"").length:-1;`);
  ui.log(`[D4] 阅读面 textContent len=${pm}`);
  // 在阅读面打字（模拟用户的普通编辑）
  await ui.ev(`const p=document.querySelector(".editor-container .ProseMirror")||document.querySelector(".ProseMirror");if(p){p.focus();const s=window.getSelection();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);s.removeAllRanges();s.addRange(r);}return true;`);
  await sleep(300);
  await ui.key("Z","KeyZ",90);
  await sleep(1500);
  // 切回编辑
  await ui.command("view.edit"); await sleep(2500);
  const t1=await ui.ev(READ);
  ui.log(`[D4] 往返后 len=${t1.length}  含\\sum=${t1.includes("\\sum")}  含\\\\sum=${t1.includes("\\\\sum")}`);
  await ui.command("file.save"); await sleep(1500);
  const disk=fs.readFileSync("D:\\10254\\桌面\\md测试.md","utf8");
  ui.log(`[D4] 磁盘 len=${disk.length} 含\\\\sum=${disk.includes("\\\\sum")}`);
  const dbl=(disk.match(/\\\\sum/g)||[]).length;
  ui.add("D4","真实文档：阅读面打字→切编辑→保存后公式转义是否被破坏", dbl===0?"PASS":"FAIL", `磁盘出现 ${dbl} 处 \\\\sum`);
});
