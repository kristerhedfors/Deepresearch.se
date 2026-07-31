import { chromium } from "@playwright/test";
const B="http://127.0.0.1:8099";
const b = await chromium.launch({ args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport:{width:1200,height:1000} });
await p.goto(`${B}/watch/`,{waitUntil:"networkidle"}); await p.waitForTimeout(1500);
const res = await p.evaluate(async ()=>{
  const core = await import("/js/watch-core.js");
  const el=document.getElementById("b-random");
  let hardErrors=0, withWarnings=0; const bad=[];
  for(let i=0;i<60;i++){
    el.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    await new Promise(r=>setTimeout(r,25));
    // Read the build the page actually holds, straight from the permalink.
    const code=decodeURIComponent(location.hash.slice(1));
    const build=core.normalizeBuild(core.decodeBuild(code));
    const v=core.checkBuild(build);
    if(!v.ok){ hardErrors++; if(bad.length<3) bad.push({build, issues:(v.issues||[]).slice(0,2)}); }
    else if((v.issues||[]).length) withWarnings++;
  }
  return { presses:60, hardErrors, withWarnings, bad };
});
console.log(JSON.stringify(res,null,2));
await b.close();
