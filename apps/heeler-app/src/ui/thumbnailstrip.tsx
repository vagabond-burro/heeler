import React, { useLayoutEffect, useRef, useState } from "react";

/** Only large strips need windowing. All rows remain reachable by scroll,
 * arrows and Tab; the spacer preserves the full library's scroll extent. */
export function ThumbnailStrip({ count, rowHeight, activeIndex, children }: {
  count: number; rowHeight: number; activeIndex: number; children: (index: number) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({top:0,height:900});
  const virtual = count > 200;
  const start = virtual ? Math.max(0,Math.min(count-1,Math.floor(viewport.top/rowHeight)-4)) : 0;
  const end = virtual ? Math.min(count,start+Math.ceil(viewport.height/rowHeight)+9) : count;
  const reveal = (index: number, focus = false) => {
    const root=ref.current;
    if(!root || index<0 || index>=count)return;
    const top=index*rowHeight;
    if(top<root.scrollTop || top+rowHeight>root.scrollTop+(root.clientHeight||viewport.height)) {
      root.scrollTop=Math.max(0,top-(root.clientHeight||viewport.height)/2);
      setViewport({top:root.scrollTop,height:root.clientHeight||viewport.height});
    }
    if(focus) requestAnimationFrame(()=>root.querySelector<HTMLElement>(`[data-strip-index="${index}"] button`)?.focus());
  };
  useLayoutEffect(()=>{
    const root=ref.current!;
    const measure=()=>setViewport(v=>({...v,height:root.clientHeight||900}));
    const observer=typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);observer?.observe(root);measure();
    return ()=>observer?.disconnect();
  },[]);
  // A fresh strip (reopened after a collapse, or switched between the
  // thumbnail and list views) centers the photo on screen before it
  // paints, and again a frame later in case its rows were still sizing
  // (2026-09-27: reopening scrolled back to the top). Measured from the
  // row's own offsetTop, in the same units as scrollTop: the strip sits
  // inside CSS zoom, where WebKit's scrollIntoView and client rects did
  // not put the photo in view although Chromium did.
  useLayoutEffect(()=>{
    const root=ref.current;
    if(!root || activeIndex<0)return;
    const center=()=>{
      const row=root.querySelector<HTMLElement>(`[data-strip-index="${activeIndex}"]`);
      // The rows are placed in the inner list, which the strip's padding
      // sets down from the scrolled box's top.
      const inner=root.firstElementChild as HTMLElement|null;
      const top=(row ? row.offsetTop : activeIndex*rowHeight)+(inner?.offsetTop??0);
      const height=row ? row.offsetHeight : rowHeight;
      const view=root.clientHeight||viewport.height;
      if(top>=root.scrollTop && top+height<=root.scrollTop+view)return;
      root.scrollTop=Math.max(0,top-(view-height)/2);
      setViewport({top:root.scrollTop,height:view});
    };
    center();
    const frame=requestAnimationFrame(center);
    return ()=>cancelAnimationFrame(frame);
    // Mount only: a click in the strip must never recenter it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useLayoutEffect(()=>{
    if(virtual)reveal(activeIndex);
    const go=()=>reveal(activeIndex);
    window.addEventListener("heeler:reveal-thumbnail",go);
    return ()=>window.removeEventListener("heeler:reveal-thumbnail",go);
  },[activeIndex,count,rowHeight,virtual]);
  return <div ref={ref} data-testid="ribbon-scroll" role="group" aria-label="Library photographs"
    onScroll={event=>setViewport({top:event.currentTarget.scrollTop,height:event.currentTarget.clientHeight||900})}
    onKeyDown={event=>{
      const row=(event.target as HTMLElement).closest<HTMLElement>("[data-strip-index]");
      if(!row)return;
      const at=Number(row.dataset.stripIndex);
      const next=event.key==="ArrowDown"?at+1:event.key==="ArrowUp"?at-1:event.key==="Home"?0:event.key==="End"?count-1:null;
      if(next!==null){event.preventDefault();event.stopPropagation();reveal(Math.max(0,Math.min(count-1,next)),true);}
      const tabs=Array.from(row.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex=\"0\"]"));
      const boundary=event.shiftKey?tabs[0]:tabs[tabs.length-1];
      if(event.key==="Tab" && event.target===boundary && virtual && (event.shiftKey?at===start&&at>0:at===end-1&&at<count-1)) {
        event.preventDefault();reveal(at+(event.shiftKey?-1:1),true);
      }
    }}
    style={{flex:1,minHeight:0,overflowY:"auto",padding:"5px 6px",position:"relative"}}>
    <div style={{height:virtual?count*rowHeight:undefined,position:"relative"}}>
      {Array.from({length:end-start},(_,offset)=>{
        const index=start+offset;
        return <div key={index} data-strip-index={index} style={virtual?{position:"absolute",top:index*rowHeight,height:rowHeight-3,left:0,right:0}:{marginBottom:3}}>{children(index)}</div>;
      })}
    </div>
  </div>;
}
