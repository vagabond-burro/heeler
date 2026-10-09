// Guided tours, the model's part (src/tour.ts): which questions get a
// tour, the check every reply passes, the stops offered for a question,
// Learn more, and the question set (src/tourquestions.json) run offline
// against the stop list with a scripted reply, then walked over the
// real reducer as a user would do each step. The Console's Assistant
// tab shows SHOW ME and sends the tour to the main window.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { plainChapter, resetAssistantConfigForTests, resetAssistantPhotoForTests, resetGuideForTests, setAssistantConfig, type Chapter } from "../assistant";
import { initialState } from "../data";
import { makeNode, NODE_CATALOG } from "../nodes";
import { setTransport, type Transport } from "../popout";
import { mainConversion, reduce, type Command, type State } from "../state";
import { checkTour, exampleNetworks, isHowTo, learnMore, nodesNamed, OFFER_LINE, relevantStops, SORRY_LINE, tourMessages, wholeTour } from "../tour";
import { instanceOf, STOP_BY_ID } from "../tourstops";
import { connectTours, resetToursForTests, TourWalk, type Tour, type TourHost } from "../tourwalk";
import { ConsolePanel } from "../ui/console";
import { _resetAssistantTabForTests } from "../ui/assistanttab";
import set from "../tourquestions.json";
import guideSet from "../assistantquestions.json";

const GUIDE_DIR = resolve(process.cwd(), "../../docs/user-guide");

function realGuide(): Chapter[] {
  const out: Chapter[] = [];
  const walk = (dir: string, pre: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
      else if (e.name.endsWith(".md") && !rel.startsWith("legal/")) {
        const raw = readFileSync(`${dir}/${e.name}`, "utf8");
        const title = raw.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? rel;
        out.push({ file: rel, title, text: plainChapter(raw) });
      }
    }
  };
  walk(GUIDE_DIR, "");
  return out;
}

const guide = realGuide();
const chaptersOf = (files: string[]) => files.map((f) => guide.find((c) => c.file === f)!);

describe("which questions get a tour", () => {
  it("takes every how-to and none of the questions about what something is (measured)", () => {
    const howTo = guideSet.questions.map((q) => q.q).filter(isHowTo);
    // 34 of the guide set's 35: the one left is an order to the model
    // ("Select this cheetah's face?"), which the answer declines.
    expect(howTo).toHaveLength(34);
    expect(guideSet.questions.map((q) => q.q).filter((q) => !isHowTo(q))).toEqual(["Select this cheetah's face?"]);
    for (const q of set.questions) expect(isHowTo(q.q), q.q).toBe(true);
    for (const q of [
      "What does Clarity do?",
      "Why is my photo too dark?",
      "What is the Tone Profile?",
      "Is Curves a Pro feature?",
      "What should I fix in this photo?",
      "Which node is making my shadows clip?",
      "Explain this graph",
    ]) {
      expect(isHowTo(q), q).toBe(false);
    }
    expect(isHowTo("Show me how to add grain")).toBe(true);
    expect(isHowTo("Where is the export button?")).toBe(true);
  });
});

describe("the check", () => {
  it("passes a good reply, with the dashes set right", () => {
    const reply = '```json\n{"steps": [{"stop": "section.curves", "say": "Open Curves \u2014 the tone curve."}, {"stop": "section.curves", "say": "again"}, {"stop": "section.color", "say": "Open Color."}]}\n```';
    const checked = checkTour(reply);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // Consecutive repeats fold.
    expect(checked.steps.map((s) => s.stop)).toEqual(["section.curves", "section.color"]);
    expect(checked.steps[0].say).toBe("Open Curves, the tone curve.");
    expect(checked.steps[1].say).toBe("Open Color.");
  });

  it("drops just an invented step and keeps the rest (drop just the invented step and recheck)", () => {
    const kept = checkTour('{"steps": [{"stop": "section.color", "say": "Open Color."}, {"stop": "control.sky-rescue.threshold", "say": "x"}, {"stop": "bw.treatment", "say": "Choose Black and White."}]}');
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.steps.map((st) => st.stop)).toEqual(["section.color", "bw.treatment"]);
      expect(kept.dropped).toEqual(["unknown stop: control.sky-rescue.threshold"]);
    }
    // A wire to a port that does not exist is dropped on its own too.
    const wire = checkTour(JSON.stringify({ steps: [{ stop: "bw.treatment", say: "Choose it." }, { stop: "graph.connect", from: "port.image_source.out", to: "port.exposure.in9", say: "Wire." }] }));
    expect(wire.ok && wire.steps.map((st) => st.stop)).toEqual(["bw.treatment"]);
  });

  it("drops the tour only when no step is left", () => {
    expect(checkTour('{"steps": [{"stop": "section.magic", "say": "y"}, {"stop": "graph.add.magic", "say": "z"}]}')).toEqual({ ok: false, reason: "every step failed: unknown stop: section.magic; unknown stop: graph.add.magic" });
  });

  it("drops a tour with no steps, or JSON that does not parse", () => {
    expect(checkTour('{"steps": []}')).toEqual({ ok: false, reason: "no steps" });
    expect(checkTour("Sure! Here is the tour: steps are Color then Treatment.").ok).toBe(false);
    expect(checkTour('{"steps": [{"stop": "section.color", "say": }]}')).toEqual({ ok: false, reason: "the reply's JSON does not parse" });
    expect(checkTour('{"tour": "section.color"}')).toEqual({ ok: false, reason: "no steps list" });
    expect(checkTour('{"steps": ["section.color"]}')).toEqual({ ok: false, reason: "a step is not an object" });
  });

  it("holds a connect to two known ports of one kind, output to input", () => {
    const connect = (from: string, to: string) => checkTour(JSON.stringify({ steps: [{ stop: "graph.connect", from, to, say: "Wire it." }] }));
    expect(connect("port.channel_extract.mask-out", "port.exposure.mask").ok).toBe(true);
    // A picture into a mask input, an input as the source, a port that
    // does not exist: all dropped.
    expect(connect("port.image_source.out", "port.exposure.mask").ok).toBe(false);
    expect(connect("port.exposure.in", "port.blur.in").ok).toBe(false);
    expect(connect("port.image_source.out", "port.exposure.in9").ok).toBe(false);
    expect(checkTour('{"steps": [{"stop": "graph.connect", "say": "Wire."}]}').ok).toBe(false);
    expect(checkTour('{"steps": [{"stop": "graph.splice", "from": "port.blur.in", "say": "x"}]}').ok).toBe(false);
    expect(checkTour('{"steps": [{"stop": "graph.disconnect", "to": "port.blur.out", "say": "x"}]}').ok).toBe(false);
  });

  it("repairs two measured slips: a splice with no node splices the one just added, and two fitting ports in a row are a wire", () => {
    const splice = checkTour('{"steps": [{"stop": "graph.add.sharpen", "say": "Add Sharpen."}, {"stop": "graph.splice", "say": "Drop it on the wire."}]}');
    expect(splice.ok && splice.steps[1]).toEqual({ stop: "graph.splice", from: "node.sharpen", say: "Drop it on the wire." });
    const ports = checkTour('{"steps": [{"stop": "port.channel_extract.mask-out", "say": "Drag from here."}, {"stop": "port.exposure.mask", "say": "to here."}]}');
    expect(ports.ok && ports.steps).toEqual([{ stop: "graph.connect", from: "port.channel_extract.mask-out", to: "port.exposure.mask", say: "Drag from here." }]);
    // Ports that do not fit stay two pointing steps.
    const apart = checkTour('{"steps": [{"stop": "port.channel_extract.mask-out", "say": "a"}, {"stop": "port.blend.in", "say": "b"}]}');
    expect(apart.ok && apart.steps.map((s) => s.stop)).toEqual(["port.channel_extract.mask-out", "port.blend.in"]);
  });
});

describe("what Heeler adds to a tour", () => {
  it("splices a picture node the tour adds and never wires, and leaves a wired one alone (the rest: tourplan.test)", () => {
    const answer = "Add a Color node and lower Saturation.";
    const added = wholeTour([{ stop: "graph.add.standard_color", say: "Add Color." }, { stop: "graph.inspector.controls", say: "Lower Saturation." }], { answer })!;
    expect(added.map((s) => s.stop)).toEqual(["graph.add.standard_color", "graph.splice", "graph.inspector.controls"]);
    expect(added[1].from).toBe("node.standard_color");
    const wired = [{ stop: "graph.add.blur", say: "a" }, { stop: "graph.splice", from: "node.blur", say: "b" }];
    expect(wholeTour(wired, { answer: "Add a Blur on the wire." })).toEqual(wired);
  });

  it("asks for a Pixel layer on the way to a brush that needs one", () => {
    expect(STOP_BY_ID.get("finish.tool.repair")!.via).toContain("finish.retouch-layer");
    expect(STOP_BY_ID.get("finish.tool.paint")!.via).not.toContain("finish.retouch-layer");
  });
});

describe("the stops offered", () => {
  it("fits the lean budget and names nodes from the question and answer", () => {
    const stops = relevantStops({ question: "How do I make a photo black and white?", answer: "Set Treatment in Color.", chapters: chaptersOf(["adjustments/black-and-white.md"]), max: 90 });
    expect(stops.length).toBeLessThanOrEqual(90);
    expect(stops.map((s) => s.id)).toContain("bw.treatment");
    // Not a graph question: no node stops.
    expect(stops.some((s) => s.id.startsWith("port."))).toBe(false);
    const messages = tourMessages({ question: "q", answer: "a", chapters: [], stops, budget: 9000 });
    expect(messages[1].content).toContain("bw.film: Film (black and white): Develops the conversion as a black and white film stock, with its filter and development.");
    expect(messages[1].content).not.toContain("[PRO]");
    expect(messages[0].content).not.toContain("Heeler Pro");
    // "Color Grade" is Color Grade, not Color too.
    expect(nodesNamed("add a Color Grade node").map((n) => n.name)).toEqual(["Color Grade"]);
    expect(nodesNamed("a Channel node, then Blend Mode").map((n) => n.name).sort()).toEqual(["Blend Mode", "Channel"]);
  });
});

/** A host over the real reducer. */
function hostFor(start: State) {
  let s = start;
  const sent: Command[] = [];
  const host: TourHost = { getState: () => s, dispatch: (c) => { sent.push(c); s = reduce(s, c); } };
  return { host, sent, state: () => s, user: (c: Command) => { s = reduce(s, c); } };
}

const spec = (t: string) => NODE_CATALOG.find((n) => n.type === t)!;

/** What the user does for a step, in the set's words. */
function userDoes(word: string, s: State, n: number): Command {
  const [verb, arg] = [word.slice(0, word.indexOf(":") < 0 ? word.length : word.indexOf(":")), word.slice(word.indexOf(":") + 1)];
  const bw = () => mainConversion(s.nodes)!;
  const group = s.exportQueue.groups[s.exportQueue.active];
  switch (verb) {
    case "open_section": return { type: "open_section", title: arg };
    case "bw_on": return { type: "set_param", id: bw().id, param: "amount", value: 100 };
    case "bw_blue": return { type: "set_param", id: bw().id, param: "blue", value: -20 };
    case "tool": return { type: "set_tool", tool: arg as "crop" };
    case "ratio": return { type: "set_crop_aspect", aspect: 16 / 9 };
    case "crop_drag": return { type: "set_crop_aspect", aspect: 16 / 9 };
    case "toggle_export": return { type: "toggle_export" };
    case "format": return { type: "export_group_settings", settings: { ...group.settings, format: arg as "png" } };
    case "size": return { type: "export_group_settings", settings: { ...group.settings, maxEdge: Number(arg) } };
    case "add": return { type: "add_node", node: makeNode(spec(arg), `u${n}`, 100 + n * 150, 500) };
    case "param": {
      const card = instanceOf(s, arg)!;
      return { type: "select_nodes", ids: [card.id] };
    }
    case "wire": {
      const [from, rest] = arg.split(">");
      const [toType, port] = [rest.slice(0, rest.lastIndexOf(".")), rest.slice(rest.lastIndexOf(".") + 1)];
      const a = instanceOf(s, from)!;
      const b = instanceOf(s, toType)!;
      return { type: "connect", wire: { from: a.id, to: b.id, toPort: port as "in", kind: port === "mask" ? "mask" : "image" } };
    }
  }
  throw new Error(`unknown user word ${word}`);
}

describe("the question set, offline", () => {
  it("has five graph tours at least", () => {
    expect(set.questions.filter((q) => q.graph).length).toBeGreaterThanOrEqual(5);
  });

  for (const q of set.questions) {
    it(q.q, () => {
      const chapters = chaptersOf(q.chapters);
      for (const c of chapters) expect(c, q.chapters.join()).toBeDefined();
      // Every stop the reply names is among those offered, at the lean
      // budget's count.
      const offered = new Set(relevantStops({ question: q.q, answer: q.answer, chapters, max: 90 }).map((s) => s.id));
      const named = q.reply.steps.flatMap((s) => [s.stop, (s as { from?: string }).from, (s as { to?: string }).to]).filter((x): x is string => !!x);
      for (const id of named) expect(offered.has(id), `${id} offered for "${q.q}"`).toBe(true);
      const checked = checkTour(JSON.stringify(q.reply));
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      expect(checked.steps.map((s) => s.stop)).toEqual(q.expect);
      for (const s of checked.steps) expect(s.say).not.toMatch(/[\u2014\u2013]/);
      // Walked as a user does it: each word is one step's doing.
      if (q.user) {
        let start = initialState();
        if (q.graph) start = reduce(start, { type: "set_mode", mode: "advanced" });
        const { host, sent, state, user } = hostFor(reduce(start, { type: "close_sections", titles: ["Color"] }));
        const tour: Tour = { id: "q", question: q.q, steps: checked.steps, followUps: [] };
        const walk = new TourWalk(tour, host, () => null);
        q.user.forEach((word, i) => {
          // The way first: a place not open is opened with NEXT.
          for (let guard = 0; walk.view()?.way && guard < 5; guard++) walk.next();
          user(userDoes(word, state(), i));
          walk.onState();
        });
        // A step with nothing left for the user (Export's button, a
        // crop drag the set does not script) goes on with NEXT.
        for (let guard = 0; walk.status === "running" && guard < 5; guard++) walk.next();
        expect(walk.status).toBe("finished");
        for (const c of sent) expect(["set_mode", "set_panel_tab", "open_section", "toggle_export", "open_palette"]).toContain(c.type);
      }
    });
  }
});

describe("Learn more", () => {
  it("after Black and White: the chapter, Film beside the mix, and Color Bend beside the node", () => {
    const steps = checkTour(JSON.stringify(set.questions[0].reply));
    expect(steps.ok).toBe(true);
    if (!steps.ok) return;
    const f = learnMore(steps.steps, guide);
    expect(f).toEqual([
      { label: "How Black and White works", kind: "help", file: "adjustments/black-and-white.md" },
      { label: "Film (black and white)", kind: "ask", question: "How do I use Film (black and white)?" },
      { label: "What Color Bend does", kind: "ask", question: "What does Color Bend do, and how do I use it?" },
    ]);
  });

  it("after a graph tour: each node's reference and an example network that uses one", () => {
    const red = set.questions.find((q) => q.q.includes("red channel"))!;
    const steps = checkTour(JSON.stringify(red.reply));
    if (!steps.ok) throw new Error(steps.reason);
    const f = learnMore(steps.steps, guide);
    expect(f[0]).toEqual({ label: "Channel in the node reference", kind: "help", file: "graph/nodes/utility.md" });
    expect(f[1]).toEqual({ label: "Exposure in the node reference", kind: "help", file: "graph/nodes/color.md" });
    // The example networks, read from the guide: one of them lowers the
    // bright tones with an Exposure.
    expect(exampleNetworks(guide).map((e) => e.title)).toContain("Darken the bright tones only");
    expect(f[2]).toEqual({ label: "Example network: Darken the bright tones only", kind: "ask", question: 'How do I build the "Darken the bright tones only" example network in the graph?' });
    for (const x of f) if (x.file) expect(guide.some((c) => c.file === x.file)).toBe(true);
    expect(STOP_BY_ID.get("graph.add.channel_extract")?.nodeType).toBe("heeler.channel_extract");
  });
});

// -- the Console's side -----------------------------------------------------------

describe("the Assistant tab's tour", () => {
  const READY = { enabled: true, address: "http://localhost:1234", model: "m", validated: "http://localhost:1234" };
  const DOCS: Record<string, string> = {
    "README.md": "# Heeler user guide\n",
    "adjustments/black-and-white.md": "# Black and White\n\nSet Treatment to black and white in Color.\n",
    "adjustments/color.md": "# Color\n\nThe Color section.\n",
  };

  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
    resetAssistantConfigForTests();
    resetAssistantPhotoForTests();
    resetGuideForTests();
    _resetAssistantTabForTests();
  });
  afterEach(() => {
    cleanup();
    delete (window as any).__TAURI_INTERNALS__;
    invoke.mockReset();
    setTransport(null);
    resetToursForTests();
  });

  function backend(tourReply: string, calls: string[]) {
    invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "assistant_validate") return { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] };
      if (name === "assistant_context_length") return null;
      if (name === "list_docs") return Object.keys(DOCS).map((file) => ({ file, title: DOCS[file].split("\n")[0].slice(2) }));
      if (name === "read_doc") return DOCS[String(args?.file)];
      if (name === "assistant_chat") {
        const system = (args?.messages as { content: string }[])[0].content;
        calls.push(system);
        if (system.includes("TABLE OF CONTENTS")) return '{"chapters": ["adjustments/black-and-white.md"]}';
        if (system.includes("into a guided tour")) return tourReply;
        return "Open **Color** and set **Treatment** to black and white.\nSources: adjustments/black-and-white.md";
      }
      return null;
    });
  }

  function fakeTransport() {
    const subs = new Map<string, ((p: any) => void)[]>();
    const sent: { ch: string; p: any }[] = [];
    const t: Transport = {
      send: (ch, p) => sent.push({ ch, p }),
      subscribe: (ch, fn) => {
        subs.set(ch, [...(subs.get(ch) ?? []), fn]);
        return () => subs.set(ch, (subs.get(ch) ?? []).filter((f) => f !== fn));
      },
    };
    const deliver = (ch: string, p: unknown) => (subs.get(ch) ?? []).forEach((fn) => fn(p));
    return { t, sent, deliver };
  }

  async function ask(q: string) {
    render(<ConsolePanel open windowed dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("console-tab-assistant"));
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: q } });
    fireEvent.click(screen.getByTestId("assistant-ask"));
    await screen.findByTestId("assistant-answer");
  }

  it("a how-to answer offers SHOW ME, which makes the checked tour then and sends it to the main window; Learn more follows its end", async () => {
    const calls: string[] = [];
    backend(JSON.stringify(set.questions[0].reply), calls);
    const { t, sent, deliver } = fakeTransport();
    setTransport(t);
    const off = connectTours("console", t);
    setAssistantConfig(READY);
    await ask("How do I make a photo black and white?");
    const show = await screen.findByTestId("assistant-show-me");
    expect(screen.getByTestId("assistant-offer-line")).toHaveTextContent(OFFER_LINE);
    // Nothing is made before the user asks for it.
    expect(calls).toHaveLength(2);
    fireEvent.click(show);
    await vi.waitFor(() => expect(sent.some((m) => m.ch === "heeler:tour-start")).toBe(true));
    // The tour call reads the question, the answer and the stops.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("into a guided tour");
    const start = sent.find((m) => m.ch === "heeler:tour-start")!;
    expect(start.p.steps.map((s: { stop: string }) => s.stop)).toEqual(["section.color", "bw.treatment", "bw.mix.blue"]);
    expect(screen.getByTestId("assistant-tour")).toHaveTextContent("The tour is running in the main window.");
    act(() => deliver("heeler:tour-status", { id: start.p.id, status: "finished" }));
    expect(screen.getByTestId("assistant-learn-more")).toHaveTextContent("How Black and White works");
    off();
  });

  it("a reply that fails the check answers with the sorry line, and a question that is not a how-to and gives no steps is offered no tour", async () => {
    const calls: string[] = [];
    backend('{"steps": [{"stop": "bw.magic", "say": "x"}]}', calls);
    setAssistantConfig(READY);
    await ask("How do I make a photo black and white?");
    fireEvent.click(await screen.findByTestId("assistant-show-me"));
    await vi.waitFor(() => expect(screen.getAllByTestId("assistant-answer")).toHaveLength(2));
    expect(calls).toHaveLength(3);
    expect(screen.getAllByTestId("assistant-answer")[1]).toHaveTextContent(SORRY_LINE);
    expect(screen.queryByTestId("assistant-show-me")).toBeNull();
    expect(screen.queryByTestId("assistant-tour-building")).toBeNull();
    cleanup();
    _resetAssistantTabForTests();
    calls.length = 0;
    const quiet = "The Treatment is the Color section's choice between color and black and white.\nSources: adjustments/black-and-white.md";
    invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "assistant_validate") return { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "m", tested: false }] };
      if (name === "list_docs") return Object.keys(DOCS).map((file) => ({ file, title: DOCS[file].split("\n")[0].slice(2) }));
      if (name === "read_doc") return DOCS[String(args?.file)];
      if (name === "assistant_chat") {
        const system = (args?.messages as { content: string }[])[0].content;
        calls.push(system);
        return system.includes("TABLE OF CONTENTS") ? '{"chapters": ["adjustments/black-and-white.md"]}' : quiet;
      }
      return null;
    });
    await ask("What does the Treatment do?");
    expect(calls).toHaveLength(2);
    expect(screen.queryByTestId("assistant-offer")).toBeNull();
  });
});
