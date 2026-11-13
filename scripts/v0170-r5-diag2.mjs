import fs from "node:fs";
import path from "node:path";
import { runProbe, sleep } from "./_lib/probe-harness.mjs";
const ROOT="D:\\AI\\markdown view\\lightmd";
const READ=`const c=document.querySelector(".cm-content");const v=c&&c.cmTile&&c.cmTile.view;return v&&v.state?v.state.doc.toString():(document.querySelector("textarea.source-editor")?.value??"");`;
for (const [tag,file] of [["A-公式+base64","formula+b64.md"],["B-公式+assets","formula+assets.md"]]) {
  const p=path.join(ROOT,"_verify-out","v4-diag",file);
  const doc=fs.readFileSync(p,"utf8");
  await runProbe({name:"v0170-r5-diag2-"+tag.replace(/[^a-zA-Z0-9]/g,""),doc,docTitle:"公式",viewMode:"edit"},async(ui)=>{
    const before=await ui.ev(READ);
    await ui.command("view.preview"); await sleep(2000);
    await ui.command("view.edit"); await sleep(2000);
    const after=await ui.ev(READ);
    await ui.command("file.save"); await sleep(1200);
    const disk=fs.readFileSync(p,"utf8");
    const fmt=(s)=>JSON.stringify(s.replace(/data:image[^)]*/g,"<B64>"));
    ui.log(`[${tag}] 初始=${fmt(before)}`);
    ui.log(`[${tag}] 往返=${fmt(after)}`);
    ui.log(`[${tag}] 磁盘=${fmt(disk)}`);
    ui.add(tag+"-公式未变", before===after?"PASS":"FAIL", `before===after: ${before===after}`);
  });
}
