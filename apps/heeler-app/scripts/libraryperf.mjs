// Offline counterpart of docshots: the installed browser, a synthetic
// React fixture and a file URL. No server, requests or downloads.
import { execFileSync } from "node:child_process";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const out="/tmp/heeler-phase6-browser";
mkdirSync(out,{recursive:true});
await build({configFile:false,plugins:[{name:"synthetic-demo",enforce:"pre",transform(code,id){
if(process.env.HEELER_PERF_REF && id.endsWith("/src/ui/chrome.tsx"))return execFileSync("git",["show",`${process.env.HEELER_PERF_REF}:apps/heeler-app/src/ui/chrome.tsx`],{encoding:"utf8"}).replace('<div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3, padding: "5px 6px" }}>','<div data-testid="ribbon-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3, padding: "5px 6px" }}>');
if(id.endsWith("/src/data.ts"))return code.replace(/import\.meta\.glob\("\.\/demo-photos\/[\s\S]*?\n  \}\)/,'({})');}},react()],build:{outDir:out,emptyOutDir:false,lib:{entry:new URL("./libraryperf.tsx",import.meta.url).pathname,name:"LibraryPerf",formats:["iife"],fileName:()=>"fixture.js"},minify:false},define:{"process.env.NODE_ENV":'"production"'}});
const css=readFileSync(out+"/style.css","utf8");
const js=readFileSync(out+"/fixture.js","utf8");
writeFileSync(out+"/index.html",`<!doctype html><style>${css}</style><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script>`);
const browser=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--enable-precise-memory-info"]});
try{
 const page=await browser.newPage();await page.setViewport({width:1280,height:900});
 await page.setRequestInterception(true);page.on("request",r=>r.url().startsWith("file:")||r.url().startsWith("data:")?r.continue():r.abort());
 await page.goto("file://"+out+"/index.html");
 const client=await page.createCDPSession();await client.send("Profiler.enable");await client.send("Profiler.start");
 let peakHeapBytes=0;
 let lastSample=Promise.resolve();
 const sampling=setInterval(()=>{lastSample=client.send("Runtime.getHeapUsage").then(h=>{peakHeapBytes=Math.max(peakHeapBytes,h.usedSize);});},25);
 let result;
 try { result=await page.evaluate(()=>window.runLibrary()); } finally { clearInterval(sampling);await lastSample; }

 const {profile}=await client.send("Profiler.stop");writeFileSync(out+"/library.cpuprofile",JSON.stringify(profile));
 await client.send("HeapProfiler.collectGarbage");const heap=await client.send("Runtime.getHeapUsage");const dom=await client.send("Memory.getDOMCounters");
 const counts=new Map();for(const node of profile.nodes)counts.set(node.id,{name:node.callFrame.functionName||"(anonymous)",ms:0});
 profile.samples?.forEach((id,i)=>{counts.get(id).ms+=(profile.timeDeltas?.[i]??0)/1000;});
 console.log(JSON.stringify({fixture:"library-browser",reference:process.env.HEELER_PERF_REF??"working tree",sampledPeakHeapBytes:peakHeapBytes,...result,retainedHeapBytes:heap.usedSize,dom,hotspots:[...counts.values()].sort((a,b)=>b.ms-a.ms).slice(0,10)}));
}finally{await browser.close();}
