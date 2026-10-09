import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mattePick, serializeGraph } from "../bridge";
import { initialState } from "../data";
import { reduce, gridWarpMesh } from "../state";
import { sourcePoint } from "../pickgeometry";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; vi.resetAllMocks(); });

it.each([
  [{ crop_x: .5, crop_w: .5, angle: 0 }, [.5,.5], [.75,.5]],
  [{ crop_x: 0, crop_w: 1, angle: 90 }, [.5,.75], [.75,.5]],
] as const)("maps an Object pick through the reducer's geometry %j", async (params, click, expected) => {
  let state = reduce(initialState(), { type: "set_tool", tool: "crop" });
  state = reduce(state, { type: "set_params", id: "crop", values: { ...params } });
  state = reduce(state, { type: "add_layer", maskType: "object" });
  const graph = serializeGraph(state);
  expect(graph.nodes.find((n) => n.id === "crop")?.params).toMatchObject(params);
  const point = sourcePoint(graph, [100,100], [...click])!;
  expect(point[0]).toBeCloseTo(expected[0]); expect(point[1]).toBeCloseTo(expected[1]);
  (window as any).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "image_metadata") return { width:100, height:100 } as any;
    if (command === "matte_pick") return (Math.abs(args.x-.75)<.001 && Math.abs(args.y-.5)<.001 ? "SphereRed" : "Ground") as any;
    throw new Error(String(command));
  });
  expect(await mattePick(state, "CryptoObject", click[0], click[1])).toBe("SphereRed");
  expect(invoke).toHaveBeenCalledWith("matte_pick", expect.objectContaining({ x:expect.closeTo(.75), y:expect.closeTo(.5) }));
});

it("undoes a grid warp after the crop", () => {
  let state = reduce(initialState(), { type:"set_tool", tool:"crop" });
  state = reduce(state, { type:"set_params", id:"crop", values:{crop_x:.5,crop_w:.5} });
  state = reduce(state, { type:"set_tool", tool:"gridwarp" });
  const mesh = gridWarpMesh(state);
  state = reduce(state, { type:"grid_warp_mesh", mesh:{ ...mesh, d:mesh.d.map(() => [.1,0]) } });
  const graph = serializeGraph(state);
  const point = sourcePoint(graph,[100,100],[.6,.5])!;
  expect(point[0]).toBeCloseTo(.75);
});
