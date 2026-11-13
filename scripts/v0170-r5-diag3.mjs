import fs from "node:fs";
import path from "node:path";
import { runProbe, sleep } from "./_lib/probe-harness.mjs";
const ROOT="D:\\AI\\markdown view\\lightmd";
const READ=`const c=document.querySelector(".cm-content");const v=c&&c.cmTile&&c.cmTile.view;return v&&v.state?v.state.doc.toString():(document.querySelector("textarea.source-editor")?.value??"");`;
const CASES = {
  "A-纯公式": ["# T","","$$","\\sum_{i=1}^{n} x_i","$$","","结尾。"].join("\n"),
  "B-公式前有空标题": ["# 新文档","","## 标题2","","## 标题3","","$$","","","","","$$","","\\sum_{i=1}^{n} x $$","","\\sum_{i=1}^{n} x_i $$","","结尾。"].join("\n"),
};
for (const [tag, doc] of Object.entries(CASES)) {
  const p=path.join(ROOT,"_verify-out","v4-diag",`d3-${tag}.md`);
  fs.writeFileSync(p, doc, "utf8");
  await runProbe({name:"v0170-r5-diag3-"+tag.replace(/[^A-Za-z0-9]/g,""),doc,docTitle:"T",viewMode:"edit"},async(ui)=>{
    const t0=await ui.ev(READ);
    // 只在编辑面打字（不进阅读），再保存
    await ui.focusSource();
    await ui.key("Z","KeyZ",90);
    await sleep(800);
    await ui.command("file.save"); await sleep(1200);
    const disk=fs.readFileSync(p,"utf8");
    const ok = disk.includes("\\sum_{i=1}") && !disk.includes("\\\\sum");
    ui.add(tag, "打字+保存后公式转义保持", ok?"PASS":"FAIL",
      `初始含\\sum=${t0.includes("\\sum")}；磁盘含\\\\sum=${disk.includes("\\\\sum")}`);
    if(!ok){
      const i=disk.indexOf("sum");
      ui.log(`[${tag}] 磁盘片段=${JSON.stringify(disk.slice(Math.max(0,i-8), i+30))}`);
    }
  });
}
