import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, ensureDocSelection, type Command, type State } from "../state";
import { App } from "../app";
import * as bridge from "../bridge";
import { GraphPersistence } from "../ui/graphpersistence";
import { ToolWindow } from "../ui/toolwindow";
import { GraphWindow } from "../ui/graphwindow";
import { SpectrumWindow } from "../ui/spectrumwindow";
import { BendWindow } from "../ui/bendwindow";
import { ConsoleWindow } from "../ui/consolewindow";
import * as popout from "../popout";
import { Ribbon } from "../ui/chrome";
import { Slider } from "../ui/simple";
import { TrackSlider } from "../ui/track";
import { ColorConsoleBlock } from "../ui/colorconsole";
import { faceAngleToOkHue, parseConsoleBands } from "../consolebands";
import { Preferences } from "../ui/preferences";
import { CatalogDialog, ConfirmDialog } from "../ui/catalogui";
import { GroupDialog } from "../ui/graph";
import { BakeDialog } from "../ui/bake";
import { StitchDialog } from "../ui/stitching";
import { DocsViewer } from "../ui/docsviewer";
import { SelectDialogs } from "../ui/selectdialogs";
import { StatusBar } from "../ui/statusbar";
import { flashStatus, _clearFlashForTests } from "../ui/hints";
import { chooseWith } from "./menuhelp";

vi.mock("@tauri-apps/api/window", () => ({getCurrentWindow: () => ({onCloseRequested: async () => () => {}, setFocus: async () => {}, isMaximized: async () => false, onResized: async () => () => {}})}));

// This matrix adds behavioral focus/name/role checks to the existing
// keynav, contrast, hint and disabled-wrapper suites, without duplicating
// their shortcut registry or color calculations.
function audit(root: HTMLElement) {
  const controls = root.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, [role="slider"], [role="switch"]');
  // A running progress dialog may have no action until it finishes.
  for (const control of controls) {
    // A native file input is an implementation detail of the visible
    // Import button. It is intentionally outside the accessibility tree.
    if (control.matches('input[type="file"]') && getComputedStyle(control).display === "none") {
      expect(control).toHaveAttribute("aria-label"); continue;
    }
    try { expect(control).toHaveAccessibleName(); } catch { throw new Error(`Unnamed control: ${control.outerHTML}`); }
    if ((control as HTMLButtonElement).disabled) {
      expect(control.parentElement?.closest('[data-hint]'), control.outerHTML.slice(0, 250)).not.toBeNull();
    } else if (getComputedStyle(control).display !== "none") expect(control.tabIndex, control.outerHTML.slice(0, 250)).toBeGreaterThanOrEqual(0);
    if (control.getAttribute("role") === "slider") {
      for (const attr of ["aria-valuemin", "aria-valuemax", "aria-valuenow"]) expect(control).toHaveAttribute(attr);
    }
    if (control.getAttribute("role") === "switch") expect(control).toHaveAttribute("aria-checked");
  }
  for (const group of root.querySelectorAll<HTMLElement>(".zoom-seg")) {
    expect(group).toHaveAttribute("role", "group"); expect(group).toHaveAccessibleName();
    for (const button of group.querySelectorAll("button")) expect(button).toHaveAttribute("aria-pressed");
  }
}

function dialogCase(name: string, face: (s: State, d: React.Dispatch<Command>, close: () => void) => React.ReactNode, setup: (s: State) => State) {
  it(`${name}: named controls, Tab trap and opener return`, async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open {name}</button>{open && face(setup(initialState()), () => setOpen(false), () => setOpen(false))}<button>Outside</button><button onClick={() => setOpen(false)}>Harness close</button></>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: `Open ${name}` });
    opener.focus(); await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(); expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    audit(dialog);
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, a[href], [tabindex="0"]'));
    if (focusable.length) {
      focusable[focusable.length - 1].focus(); await user.tab(); expect(document.activeElement).toBe(focusable[0]);
      await user.tab({ shift: true }); expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    } else { await user.tab(); expect(document.activeElement).toBe(dialog); }
    // Exercise teardown through an external state change too: native
    // close and async completion must return focus just like a button.
    fireEvent.click(screen.getByRole("button", { name: "Harness close" }));
    expect(opener).toHaveFocus();
  });
}

describe("accessibility matrix: dialogs", () => {
  dialogCase("Preferences", (s,d) => <Preferences state={s} dispatch={d}/>, s => ({...s,prefsOpen:true}));
  dialogCase("Catalogs and recovery", (_,d,close) => <CatalogDialog open onClose={close} dispatch={d}/>, s => s);
  dialogCase("Confirm", (s,d) => <ConfirmDialog state={s} dispatch={d}/>, s => reduce(s, {type:"ask_confirm",action:{kind:"delete_take", imageId:s.activeImage!,takeId:"take_1",name:"First take"}} as Command));
  dialogCase("Group", (s,d) => <GroupDialog state={s} dispatch={d}/>, s => ({...s,groupDialogOpen:true}));
  dialogCase("Bake", (s,d) => <BakeDialog state={s} dispatch={d}/>, s => ({...s,bake:{ids:[s.activeImage!]}} as State));
  dialogCase("Panorama", (s,d) => <StitchDialog state={s} dispatch={d}/>, s => ({...s,stitch:{image:"synthetic",fraction:0.5,stage:"Matching frames",error:null}}));
  for (const param of ["smooth", "feather", "grow"] as const) {
    dialogCase(`Selection ${param}`, (s,d) => <SelectDialogs state={s} dispatch={d}/>, s => {
      s=ensureDocSelection(s).state;
      s=reduce(s,{type:"open_select_dialog",dialog:{kind:"param",param}});
      return s;
    });
  }
  dialogCase("Documentation", (s,d) => <DocsViewer state={s} dispatch={d}/>, s => ({...s,docsOpen:true}));
});

describe("accessibility matrix: controls and announcements", () => {
  it("panel slider and Preferences track have keyboard/pointer value parity", async () => {
    const user = userEvent.setup();
    for (const kind of ["panel", "track"]) {
      const writes: number[] = [];
      const node = initialState().nodes.find(n => n.id === "exposure")!;
      const view = render(kind === "panel" ? <Slider label="Exposure" param="exposure" node={{...node,params:{exposure:0}}} range={[0,100]} dispatch={c => {if(c.type === "set_param") writes.push(c.value)}}/> : <TrackSlider label="App zoom" value={0} lo={0} hi={100} onChange={v=>writes.push(v)}/>);
      audit(view.container);
      await user.tab();
      const slider = screen.getByRole("slider"); expect(slider).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      const keyboard = writes.pop();
      vi.spyOn(slider,"getBoundingClientRect").mockReturnValue({left:0,width:100} as DOMRect);
      fireEvent(slider,new MouseEvent("pointerdown",{bubbles:true,clientX:1,button:0}));
      expect(writes.pop()).toBe(keyboard);
      view.unmount();
    }
  });
  it("Color Tune band sliders expose names, values and keyboard changes", async () => {
    const user = userEvent.setup();
    const s = reduce(initialState(),{type:"set_category",title:"Color Tune",on:true});
    const node = s.nodes.find(n=>n.type === "heeler.color_console")!;
    const dispatch = vi.fn();
    const view = render(<ColorConsoleBlock node={node} dispatch={dispatch} band="r" onBand={()=>{}}/>);
    audit(view.container);
    const wheel=screen.getByRole("slider",{name:"Band wheel"});
    wheel.focus();await user.keyboard("{ArrowRight}");
    // The arrows step in screen space: from the center, right is three
    // o'clock on the face, whose color is the OkLab hue the bridge names
    // for 0 degrees, not OkLab hue 0 itself (second pass, 26.3.2).
    const write=dispatch.mock.calls.find(c=>c[0].type === "set_text_param");
    const written=parseConsoleBands(write![0].value)[0].wheel!;
    const rad=faceAngleToOkHue(0)*Math.PI/180;
    expect(written[0]).toBeCloseTo(0.05*Math.cos(rad), 10);
    expect(written[1]).toBeCloseTo(0.05*Math.sin(rad), 10);
    dispatch.mockClear();
    const sliders = screen.getAllByRole("slider");
    for (const slider of sliders.filter(s=>s.classList.contains("strack"))) {
      slider.focus(); await user.keyboard("{ArrowRight}"); expect(dispatch).toHaveBeenCalled();
      const writes=()=>dispatch.mock.calls.filter(c=>c[0].type !== "begin_gesture" && c[0].type !== "end_gesture").map(c=>c[0]);
      const keyboard=writes();dispatch.mockClear();
      const lo=Number(slider.getAttribute("aria-valuemin")),hi=Number(slider.getAttribute("aria-valuemax")),value=Number(slider.getAttribute("aria-valuenow"));
      vi.spyOn(slider,"getBoundingClientRect").mockReturnValue({left:0,width:100} as DOMRect);
      fireEvent(slider,new MouseEvent("pointerdown",{bubbles:true,clientX:100*(value+(hi-lo)/100-lo)/(hi-lo),button:0}));
      const pointer=writes();expect(pointer).toHaveLength(keyboard.length);
      // Pointer coordinates incur floating-point interpolation; commands
      // agree to 10 decimal places, far below a visible band adjustment.
      const normalize=(commands:typeof pointer)=>JSON.parse(JSON.stringify(commands).replace(/-?\d+\.\d+(?:e[+-]?\d+)?/g,n=>String(Number(Number(n).toFixed(10)))));
      expect(normalize(pointer)).toEqual(normalize(keyboard));dispatch.mockClear();
    }
  });
  it("status flashes are announced without moving focus", () => {
    const view=render(<><button>Keep focus</button><StatusBar state={initialState()} dispatch={()=>{}} previewUrl={null} previewError={null} previewMs={null} previewBackend={null} renderSeq={0}/></>);
    screen.getByRole("button",{name:"Keep focus"}).focus();
    act(()=>flashStatus("Preview ready"));
    expect(screen.getByRole("status")).toHaveTextContent("Preview ready");
    expect(screen.getByRole("button",{name:"Keep focus"})).toHaveFocus();
    act(()=>_clearFlashForTests()); view.unmount();
  });
  it("menus and hinted chips work with Tab, Enter and arrows", async () => {
    const user=userEvent.setup(); render(<App/>);
    const opener=screen.getByTestId("menu-photo"); opener.focus(); await user.keyboard("{Enter}");
    const menu=screen.getByTestId("menu-photo-list"); expect(menu).toHaveAttribute("role","menu");
    audit(menu); expect(menu.contains(document.activeElement)).toBe(true);
    const first=document.activeElement; await user.keyboard("{ArrowDown}"); expect(document.activeElement).not.toBe(first);
    await user.keyboard("{Escape}"); expect(opener).toHaveFocus();
    const chips=screen.getAllByRole("button").filter(b=>b.classList.contains("chip") && b.closest('[data-hint]'));
    expect(chips.length).toBeGreaterThan(0); for(const chip of chips) expect(chip).toHaveAccessibleName();
  });
});


describe("accessibility matrix: complete surfaces", () => {
  it("expanded black and white, infrared, Far, Zones, Print and Grain controls are named and reachable", async () => {
    const user = userEvent.setup();
    const view = render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "r72");
    await chooseWith(user, screen.getByTestId("bw-far-menu"), "w25");
    await user.click(screen.getByTestId("bw-ir-curve-fold"));
    await user.click(screen.getByTestId("bw-collision-view"));
    await user.click(screen.getByTestId("bw-zones-fold"));
    for (const section of ["print", "grain"]) {
      const fold = screen.getByTestId(`collapse-${section}`);
      if (fold.getAttribute("aria-expanded") === "false") await user.click(fold);
    }
    for (const id of ["bw-mixer", "bw-zones", "print-block", "grain-frame"]) audit(screen.getByTestId(id));
    view.unmount();
  });
  // Every category, every control, twice each: about five seconds on
  // Windows on its own, over vitest's five-second default under the
  // full parallel run, so the timeout is its own.
  it("every Preferences category has named reachable controls and pressed segments", async () => {
    const user=userEvent.setup(); const dispatch=vi.fn();
    const view=render(<Preferences state={{...initialState(),prefsOpen:true}} dispatch={dispatch}/>);
    const categories=Array.from(view.container.querySelectorAll<HTMLElement>('[data-testid^="prefs-tab-"]'));
    for(const category of categories){
      category.focus();await user.keyboard("{Enter}");const dialog=screen.getByRole("dialog");audit(dialog);
      for(const control of dialog.querySelectorAll<HTMLElement>('[role="switch"], .zoom-seg button')){
        // The update-backup policy lives outside the catalog in its own
        // file (26.3), so its toggle writes through the bridge instead of
        // dispatching; it is still named, focusable and keyboard-driven.
        if(control.dataset.testid==="prefs-upgrade-backup")continue;
        // The assistant's switch asks for its notice before it turns on, so
        // its first press shows the notice rather than dispatching; the
        // keyboard reaches that too.
        if(control.dataset.testid==="prefs-assistant-enable"){control.focus();await user.keyboard(" ");expect(await screen.findByTestId("assistant-notice")).toBeInTheDocument();continue;}
        dispatch.mockClear();control.focus();await user.keyboard(" ");const keyboard=dispatch.mock.calls.map(c=>c[0]);
        dispatch.mockClear();await user.click(control);expect(dispatch.mock.calls.map(c=>c[0])).toEqual(keyboard);if(control.dataset.testid?.startsWith("prefs-app-zoom"))expect(control).toHaveAttribute("aria-pressed","true");else expect(keyboard.length).toBeGreaterThan(0);
      }
    }
  }, 30000);
  it("recovery is an alert and its actions remain keyboard reachable", async () => {
    const native=vi.spyOn(bridge,"isTauri").mockReturnValue(true);
    const load=vi.spyOn(bridge,"loadGraphResult").mockResolvedValue({status:"blocked",path:"synthetic.json",error:"invalid",broken:null,last_good:false});
    const view=render(<GraphPersistence state={initialState()} dispatch={()=>{}}/>);
    try {const notice=await screen.findByTestId("save-recovery-notice");expect(notice).toHaveAttribute("role","alert");audit(notice);}
    finally{view.unmount();native.mockRestore();load.mockRestore();}
  });
  it("large strips retain keyboard access to both ends and the context menu", async () => {
    const user=userEvent.setup();
    let s=initialState();s.images=Array.from({length:5000},(_,i)=>({...s.images[0],id:`row-${i}`,name:`Photo ${i}`,src:""}));s.activeImage="row-0";
    const view=render(<Ribbon state={s} dispatch={()=>{}}/>);
    expect(view.container.querySelectorAll('[data-testid^="thumb-row-"]').length).toBeLessThan(100);
    screen.getByRole("button", { name: "Select Photo 0" }).focus();await user.keyboard("{End}");
    await waitFor(()=>expect(screen.getByRole("button", { name: "Select Photo 4999" })).toHaveFocus());
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu=await screen.findByRole("menu");audit(menu);expect(menu.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await user.keyboard("{Home}");await waitFor(()=>expect(screen.getByRole("button", { name: "Select Photo 0" })).toHaveFocus());
  });
  it.each(Object.keys(popout.TOOL_WINDOWS) as popout.ToolWindowKind[])("%s pop-out returns focus after closing", async kind => {
    const user=userEvent.setup();vi.spyOn(window,"open").mockReturnValue({closed:false,close:()=>{}} as Window);
    render(<><button onClick={()=>void popout.openToolWindow(kind)}>Open tool</button><button onClick={()=>void popout.closeToolWindow(kind)}>Close tool</button></>);
    const opener=screen.getByRole("button",{name:"Open tool"});opener.focus();await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button",{name:"Close tool"}));await waitFor(()=>expect(opener).toHaveFocus());
  });
  it.each(["wheels","curves","toneeq","recolor","colorconsole","graph","spectrum","bend","console"])("%s pop-out face has named reachable controls", async kind=>{
    let s=initialState();for(const title of ["Color Wheels","Curves","Relight","Recolor","Color Tune","Color Bend"])s=reduce(s,{type:"set_category",title,on:true});
    const listeners=new Map<string,((p:any)=>void)[]>();
    const bus:popout.Transport={send(channel,payload){for(const f of listeners.get(channel)??[])f(payload);if(channel===popout.STATE_REQUEST)for(const f of listeners.get(popout.STATE_CHANNEL)??[])f(popout.graphSnapshot(s));},subscribe(channel,f){listeners.set(channel,[...(listeners.get(channel)??[]),f]);return()=>listeners.set(channel,(listeners.get(channel)??[]).filter(x=>x!==f));}};
    popout.setTransport(bus);
    const view=render(kind==="graph"?<GraphWindow/>:kind==="spectrum"?<SpectrumWindow/>:kind==="bend"?<BendWindow/>:kind==="console"?<ConsoleWindow/>:<ToolWindow kind={kind as popout.ToolWindowKind}/>);
    try{await act(async()=>{bus.send(popout.STATE_CHANNEL,popout.graphSnapshot(s));});audit(view.container);}finally{view.unmount();popout.setTransport(null);}
  });
});

it.each(["luma","color","contrast","depth"])("%s range dialog has keyboard controls and returns to its menu opener", async mode=>{
  const user=userEvent.setup();render(<App/>);
  await user.click(screen.getByTestId("panel-tab-layers"));
  await user.click(screen.getByTestId("art-add-content"));
  await user.click(screen.getByTestId("art-tool-select"));
  const menu=screen.getByTestId("menu-select");menu.focus();await user.keyboard("{Enter}");
  expect(screen.getByTestId("menu-select-from-center")).toHaveAttribute("role","menuitemcheckbox");
  expect(screen.getByTestId("menu-select-from-center")).toHaveAttribute("aria-checked");
  const sub=screen.getByTestId("menu-select-by");sub.focus();await user.keyboard("{ArrowRight}");
  const command=screen.getByTestId(`menu-select-${mode}`);command.focus();await user.keyboard("{Enter}");
  const dialog=await screen.findByRole("dialog");audit(dialog);
  const cancel=screen.getByTestId("select-range-dialog-cancel");cancel.focus();await user.keyboard("{Enter}");
  expect(menu).toHaveFocus();
});

it.each([
  ["graph",popout.openGraphWindow,popout.closeGraphWindow],
  ["spectrum",popout.openSpectrumWindow,popout.closeSpectrumWindow],
  ["bend",popout.openBendWindow,popout.closeBendWindow],
  ["console",popout.openConsoleWindow,popout.closeConsoleWindow],
] as const)("%s native-window close route returns focus", async (_,open,close)=>{
  const user=userEvent.setup();vi.spyOn(window,"open").mockReturnValue({closed:false,close:()=>{}} as Window);
  render(<><button onClick={()=>void open()}>Open window</button><button onClick={()=>void close()}>Close window</button></>);
  const opener=screen.getByRole("button",{name:"Open window"});opener.focus();await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button",{name:"Close window"}));await waitFor(()=>expect(opener).toHaveFocus());
});
