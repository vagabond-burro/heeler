import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { chartDefs, type ChartDef } from "../bridge";
import { addChart, loadCharts, reloadCharts, resetChartsForTests } from "../charts";
import { initialState } from "../data";
import { reduce } from "../state";
import { ChartToolOverlay, ColorCheckerControls } from "../ui/colorchecker";
import { menuRows } from "./menuhelp";
vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), chartDefs:vi.fn() }));
const chart = (id:string):ChartDef => ({id,name:id,rows:1,cols:1,neutrals:[0],skin:[],patches:[{name:"gray",rgb:[.5,.5,.5],target:true}]});
const deferred = () => {
  let resolve!:(v:ChartDef[])=>void;
  let reject!:(e:Error)=>void;
  const promise=new Promise<ChartDef[]>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
beforeEach(()=>{ resetChartsForTests(); vi.mocked(chartDefs).mockReset(); });

it("clears a rejected request so the next load can retry", async()=>{
  vi.mocked(chartDefs).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([chart("fresh")]);
  await expect(loadCharts()).rejects.toThrow("offline");
  expect(await loadCharts()).toEqual([chart("fresh")]);
  expect(chartDefs).toHaveBeenCalledTimes(2);
});
it("an older load finishing after reload and a custom save cannot replace either", async()=>{
  const old=deferred(), fresh=deferred();
  vi.mocked(chartDefs).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const a=loadCharts(), b=reloadCharts();
  fresh.resolve([chart("imported")]); await b;
  addChart(chart("custom"));
  old.resolve([chart("stale")]);
  expect(await a).toEqual([chart("imported"),chart("custom")]);
  expect(await loadCharts()).toEqual([chart("imported"),chart("custom")]);
});
it("a save during an unresolved reload survives its late answer", async()=>{
  const old=deferred();
  vi.mocked(chartDefs).mockReturnValueOnce(old.promise).mockResolvedValueOnce([chart("built-in")]);
  const pending=reloadCharts();
  addChart(chart("custom"));
  old.resolve([chart("obsolete")]);
  expect(await pending).toEqual([chart("built-in"),chart("custom")]);
});
it("a stale rejection cannot clear a newer request", async()=>{
  const old=deferred(), fresh=deferred();
  vi.mocked(chartDefs).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const a=loadCharts(), b=reloadCharts();
  old.reject(new Error("stale failure"));
  await Promise.resolve();
  expect(loadCharts()).toBe(b);
  fresh.resolve([chart("new")]);
  expect(await a).toEqual([chart("new")]);
});
it.each(["controls","overlay"])("%s shows a retry after a chart-list failure", async(seat)=>{
  vi.mocked(chartDefs).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce([chart("colorchecker-classic")]);
  const state=reduce(initialState(),{type:"set_category",title:"Color Checker",on:true});
  const node=state.nodes.find(n=>n.type==="heeler.color_checker")!;
  render(seat==="controls"?<ColorCheckerControls state={state} dispatch={()=>{}}/>:
    <ChartToolOverlay state={state} node={node} dispatch={()=>{}} norm={()=>[.5,.5]}/>);
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
  await act(async()=>{fireEvent.click(screen.getByTestId("charts-retry"));});
  await waitFor(()=>expect(screen.queryByRole("alert")).toBeNull());
  expect(chartDefs).toHaveBeenCalledTimes(2);
  if(seat==="controls") expect(menuRows(screen.getByTestId("colorchecker-chart")).map(([,label])=>label)).toContain("colorchecker-classic");
  else expect(screen.getByTestId("chart-tool-overlay")).toBeTruthy();
});
