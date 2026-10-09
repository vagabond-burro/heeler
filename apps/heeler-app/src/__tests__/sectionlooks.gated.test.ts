// The graphs a held section look sends the engine, one per look, for
// the desktop's looks probe (src-tauri/src/looks_probe.rs), which
// renders each on a repository photograph with the real engine so the
// looks can be judged by eye. Always checks every look serializes with
// its section in the chain; writes the files only on request:
//
//   GEN_LOOK_GRAPHS=<dir> npx vitest run src/__tests__/sectionlooks.gated.test.ts
import { expect, it } from "vitest";
import { serializeGraph } from "../bridge";
import { initialState } from "../data";
import { SECTION_LOOKS } from "../sectionlooks";
import { lookPreviewState, reduce, type State } from "../state";

it("every look serializes with its section switched on in the chain", () => {
  const base = initialState();
  const fresh: State = {
    ...base,
    activeImage: "probe",
    nodes: structuredClone(base.defaultGraph.nodes),
    wires: structuredClone(base.defaultGraph.wires),
  };
  const graphs: Record<string, unknown> = { base: serializeGraph(fresh) };
  for (const look of SECTION_LOOKS) {
    const shown = lookPreviewState(reduce(fresh, { type: "preview_section_look", id: look.id }));
    const g = serializeGraph(shown);
    const id = look.section === "Relight" ? "toneeq" : "recolor";
    const n = g.nodes.find((x) => x.id === id);
    expect(n?.enabled, look.id).toBe(true);
    expect(g.connections.some((c) => c.to[0] === id), look.id).toBe(true);
    graphs[look.id] = g;
  }
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  const dir = env?.GEN_LOOK_GRAPHS;
  if (!dir) return;
  const load = (m: string) =>
    import(/* @vite-ignore */ m) as Promise<{
      writeFileSync?: (p: string, d: string) => void;
      mkdirSync?: (p: string, o: { recursive: boolean }) => void;
      join?: (...s: string[]) => string;
    }>;
  return Promise.all([load("fs"), load("path")]).then(([fs, path]) => {
    fs.mkdirSync!(dir, { recursive: true });
    for (const [id, g] of Object.entries(graphs)) fs.writeFileSync!(path.join!(dir, `${id}.json`), JSON.stringify(g));
  });
});
