import React, { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { initialState } from "../src/data";
import { reduce, visibleImages, type Command } from "../src/state";
import { Ribbon } from "../src/ui/chrome";
import "../src/theme.css";

const state = initialState();
state.images = Array.from({length:5000},(_,i)=>({...state.images[0],id:`synthetic-${i}`,name:`Photo-${String(i).padStart(5,"0")}.png`,src:"",stars:i%6}));
state.activeImage=state.images[0].id;
state.ribbonOpen=true;
let dispatch: React.Dispatch<Command>;
let current=state;
function Library(){ const [s,d]=useReducer(reduce,state); dispatch=d;current=s;return <Ribbon state={s} dispatch={d}/>; }
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
(window as any).runLibrary = async () => {
 const root=createRoot(document.getElementById("root")!);
 let t=performance.now();flushSync(()=>root.render(<Library/>));await frame();const firstPaintMs=performance.now()-t;
 const strip=document.querySelector<HTMLElement>('[data-testid="ribbon-scroll"]')!;
 if(!strip)throw new Error("missing ribbon strip");
 const nodes=document.querySelectorAll("*").length;
 t=performance.now();
 for(let i=0;i<=100;i++){strip.scrollTop=(strip.scrollHeight-strip.clientHeight)*i/100;await frame();}
 const scrollMs=performance.now()-t;
 if(strip.scrollTop+strip.clientHeight<strip.scrollHeight-2)throw new Error("did not reach strip end");
 t=performance.now();flushSync(()=>dispatch({type:"set_filter_name",text:"Photo-000"}));await frame();const filterMs=performance.now()-t;
 if(visibleImages(current).length!==100)throw new Error("filter count");
 flushSync(()=>dispatch({type:"set_filter_name",text:""}));await frame();
 t=performance.now();flushSync(()=>dispatch({type:"set_ribbon_sort",desc:true}));await frame();const sortMs=performance.now()-t;
 if(visibleImages(current).length!==5000)throw new Error("sort count");
 return {firstPaintMs,scrollMs,filterMs,sortMs,nodes,sessionJsonBytes:new TextEncoder().encode(JSON.stringify(current)).length};
};
