// The assistant, phase 1: Preferences > Assistant in the owner's order.
// The Tauri invoke is mocked; nothing here reaches a server.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  TESTED_MODEL_LIST,
  ACKNOWLEDGMENT_TEXT,
  DISCLAIMER_TEXT,
  resetAssistantConfigForTests,
  validationWords,
} from "../assistant";
import type { AssistantValidation } from "../bridge";
import { initialState } from "../data";
import { setTransport } from "../popout";
import { reduce, type State } from "../state";
import { Preferences } from "../ui/preferences";
import { choose, menuRows } from "./menuhelp";

type Handler = (args: Record<string, unknown> | undefined) => unknown;

/** Answers invoke by command name. The rest of the dialog asks its
 * own questions (the catalog update policy); those answer null. An
 * assistant command the test did not list rejects, so it is loud. */
function backend(handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const h = handlers[name];
    if (!h) {
      if (name.startsWith("assistant_")) throw new Error(`unexpected command ${name}`);
      return null;
    }
    return h(args);
  });
}

const called = (name: string) => invoke.mock.calls.some(([n]) => n === name);

const NO_RECORDS = { disclaimer: null, acknowledged: [], disclaimerVersion: "2026-09-28" };
const ACCEPTED = { document: "Heeler assistant notice", version: "2026-09-28", unixTime: 1_790_000_000, fingerprint: "fp" };

let latest: State;
function Harness({ prefs = {} }: { prefs?: Partial<State["prefs"]> }) {
  const [state, dispatch] = useReducer(
    reduce,
    reduce(reduce(initialState(), { type: "open_prefs" }), { type: "set_prefs", prefs }),
  );
  latest = state;
  return <Preferences state={state} dispatch={dispatch} />;
}

function openAssistantPrefs(prefs: Partial<State["prefs"]> = {}) {
  render(<Harness prefs={prefs} />);
  fireEvent.click(screen.getByTestId("prefs-tab-assistant"));
}

beforeEach(() => {
  // The module mock answers bridge.ts; the internals answer the same
  // mock when @tauri-apps/api/core is reached by another module path
  // (a node_modules that is a link resolves to two ids).
  (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
  resetAssistantConfigForTests();
});

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI_INTERNALS__;
  invoke.mockReset();
  setTransport(null);
});

describe("Preferences > Assistant", () => {
  // Free for questions (2026-09-28): no upgrade panel here; the
  // notice is asked on a free copy as on Pro.
  it("works on a free copy: the switch, and the notice before it turns on", async () => {
    backend({
      assistant_records: () => NO_RECORDS,
      assistant_accept_disclaimer: () => ACCEPTED,
      assistant_validate: () => ({ kind: "nothingAnswering", address: "127.0.0.1:1234" }),
    });
    openAssistantPrefs();
    expect(screen.queryByTestId("assistant-pro-pitch")).toBeNull();
    const toggle = screen.getByTestId("prefs-assistant-enable");
    await waitFor(() => expect(called("assistant_records")).toBe(true));
    fireEvent.click(toggle);
    expect(screen.getByTestId("assistant-notice")).toHaveTextContent(DISCLAIMER_TEXT);
    expect(latest.prefs.assistantEnabled).toBe(false);
    fireEvent.click(screen.getByTestId("assistant-notice-accept"));
    await waitFor(() => expect(latest.prefs.assistantEnabled).toBe(true));
    expect(screen.getByTestId("prefs-assistant-address")).toBeInTheDocument();
    await waitFor(() => expect(called("assistant_validate")).toBe(true));
  });

  it("is off by default, and turning it on shows the notice and records its acceptance", async () => {
    let accepted = false;
    backend({
      assistant_records: () => NO_RECORDS,
      assistant_accept_disclaimer: () => ((accepted = true), ACCEPTED),
      assistant_validate: () => ({ kind: "nothingAnswering", address: "127.0.0.1:1234" }),
    });
    openAssistantPrefs();
    const toggle = screen.getByTestId("prefs-assistant-enable");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(latest.prefs.assistantAddress).toBe("http://localhost:1234");
    // The address row waits until the assistant is on.
    expect(screen.queryByTestId("prefs-assistant-address")).toBeNull();
    await waitFor(() => expect(called("assistant_records")).toBe(true));
    fireEvent.click(toggle);
    const notice = screen.getByTestId("assistant-notice");
    expect(notice).toHaveTextContent(DISCLAIMER_TEXT);
    // Not on until the notice is accepted.
    expect(latest.prefs.assistantEnabled).toBe(false);
    fireEvent.click(screen.getByTestId("assistant-notice-accept"));
    await waitFor(() => expect(latest.prefs.assistantEnabled).toBe(true));
    expect(accepted).toBe(true);
    expect(screen.queryByTestId("assistant-notice")).toBeNull();
    expect(screen.getByTestId("assistant-notice-record")).toHaveTextContent("Notice accepted 2026-09-21.");
    // The address is there now, prefilled with LM Studio's default.
    expect(screen.getByTestId("prefs-assistant-address")).toHaveValue("http://localhost:1234");
  });

  it("declining the notice records nothing and leaves it off", async () => {
    backend({ assistant_records: () => NO_RECORDS });
    openAssistantPrefs();
    await waitFor(() => expect(called("assistant_records")).toBe(true));
    fireEvent.click(screen.getByTestId("prefs-assistant-enable"));
    fireEvent.click(screen.getByTestId("assistant-notice-decline"));
    expect(latest.prefs.assistantEnabled).toBe(false);
    expect(called("assistant_accept_disclaimer")).toBe(false);
  });

  it("an accepted notice is not asked again", async () => {
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: () => ({ kind: "noModels", address: "127.0.0.1:1234" }),
    });
    openAssistantPrefs();
    await waitFor(() => expect(called("assistant_records")).toBe(true));
    fireEvent.click(screen.getByTestId("prefs-assistant-enable"));
    expect(screen.queryByTestId("assistant-notice")).toBeNull();
    expect(latest.prefs.assistantEnabled).toBe(true);
  });

  it("Validate says what it found, in words", async () => {
    let answer: AssistantValidation = { kind: "nothingAnswering", address: "127.0.0.1:1234" };
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: (args) => {
        expect(args).toEqual({ address: latest.prefs.assistantAddress });
        return answer;
      },
    });
    openAssistantPrefs({ assistantEnabled: true });
    const status = await screen.findByTestId("prefs-assistant-status");
    expect(status).toHaveTextContent("Nothing answers at 127.0.0.1:1234. Is LM Studio running with its server started?");
    answer = { kind: "noModels", address: "127.0.0.1:1234" };
    fireEvent.click(screen.getByTestId("prefs-assistant-validate"));
    await waitFor(() => expect(screen.getByTestId("prefs-assistant-status")).toHaveTextContent("has no model loaded"));
    answer = { kind: "notLocal", host: "example.com:1234", address: "93.184.216.34" };
    fireEvent.change(screen.getByTestId("prefs-assistant-address"), { target: { value: "http://example.com:1234" } });
    fireEvent.click(screen.getByTestId("prefs-assistant-validate"));
    await waitFor(() => expect(screen.getByTestId("prefs-assistant-status")).toHaveAttribute("data-kind", "notLocal"));
    expect(screen.getByTestId("prefs-assistant-status")).toHaveTextContent("example.com:1234 is at 93.184.216.34");
    answer = { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "a", tested: false }, { id: "b", tested: false }] };
    fireEvent.click(screen.getByTestId("prefs-assistant-validate"));
    await waitFor(() => expect(screen.getByTestId("prefs-assistant-status")).toHaveTextContent("Connected to 127.0.0.1:1234: 2 models."));
  });

  it("lists the tested models in two columns, model and app, five rows before it scrolls", async () => {
    // 2026-09-29: "a simple scroll list (displays up to 5 models before
    // scrolling) below the text ... the model in the first column and the
    // platform (LM Studio, Ollama) in the other".
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: () => ({ kind: "nothingAnswering", address: "127.0.0.1:1234" }),
    });
    openAssistantPrefs({ assistantEnabled: true });
    const note = await screen.findByTestId("prefs-assistant-tested");
    const list = screen.getByTestId("prefs-assistant-tested-list");
    expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Model", "Platform"]);
    const rows = screen.getAllByTestId("prefs-assistant-tested-row");
    expect(rows).toHaveLength(TESTED_MODEL_LIST.length);
    rows.forEach((row, i) => {
      const cells = row.querySelectorAll('[role="cell"]');
      expect(cells).toHaveLength(2);
      expect(cells[0].textContent).toBe(TESTED_MODEL_LIST[i].model);
      expect(cells[1].textContent).toBe(TESTED_MODEL_LIST[i].platform);
      expect(["LM Studio", "Ollama"]).toContain(TESTED_MODEL_LIST[i].platform);
    });
    // Five rows' height, then it scrolls.
    const body = screen.getByTestId("prefs-assistant-tested-rows");
    expect(body.style.overflowY).toBe("auto");
    expect(parseFloat(body.style.maxHeight)).toBe(5 * parseFloat(rows[0].style.height));
  });

  it("every outcome has its sentence", () => {
    const words = (v: AssistantValidation) => validationWords(v);
    expect(words({ kind: "notLocal", host: "h:1", address: "8.8.8.8" })).toBe(
      "h:1 is at 8.8.8.8, which is neither this computer nor the home network, so the assistant will not talk to it.",
    );
    expect(words({ kind: "connected", address: "x", models: [{ id: "m", tested: true }] })).toBe("Connected to x: 1 model.");
    expect(words({ kind: "notAModelServer", address: "x", status: 404 })).toContain("not as a model server");
    expect(words({ kind: "badAddress", reason: "Type the address." })).toBe("Type the address.");
    expect(words({ kind: "notFound", host: "nas.local:1", reason: "x" })).toContain("nas.local:1 could not be found");
  });

  it("an untested model asks once for the acknowledgment, which is recorded", async () => {
    const acknowledged: string[] = [];
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: () => ({
        kind: "connected",
        address: "127.0.0.1:1234",
        models: [{ id: "qwen3-vl-4b@q4_k_m", tested: false }, { id: "tested-one", tested: true }],
      }),
      assistant_acknowledge_model: (args) => {
        acknowledged.push(String(args?.model));
        return acknowledged.map((model) => ({ model, unixTime: 1 }));
      },
    });
    openAssistantPrefs({ assistantEnabled: true });
    await screen.findByTestId("prefs-assistant-status");
    const select = screen.getByTestId("prefs-assistant-model");
    expect(select).not.toBeDisabled();
    expect(menuRows(select)).toContainEqual(["tested-one", "tested-one (Tested with Heeler)"]);
    // A tested model is taken with no question.
    choose(select, "tested-one");
    expect(screen.queryByTestId("assistant-acknowledge")).toBeNull();
    expect(latest.prefs.assistantModel).toBe("tested-one");
    expect(latest.prefs.assistantValidated).toBe("http://localhost:1234");
    // An untested one asks, and is not taken until acknowledged.
    choose(select, "qwen3-vl-4b@q4_k_m");
    const card = screen.getByTestId("assistant-acknowledge");
    expect(card).toHaveTextContent(ACKNOWLEDGMENT_TEXT);
    expect(latest.prefs.assistantModel).toBe("tested-one");
    fireEvent.click(screen.getByTestId("assistant-acknowledge-accept"));
    await waitFor(() => expect(latest.prefs.assistantModel).toBe("qwen3-vl-4b@q4_k_m"));
    expect(acknowledged).toEqual(["qwen3-vl-4b@q4_k_m"]);
    // Once acknowledged, picking it again asks nothing.
    choose(select, "tested-one");
    choose(select, "qwen3-vl-4b@q4_k_m");
    expect(screen.queryByTestId("assistant-acknowledge")).toBeNull();
    expect(acknowledged).toHaveLength(1);
  });

  it("links to the apps it works with, worded that way", async () => {
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: () => ({ kind: "noModels", address: "x" }),
      open_web_url: () => true,
    });
    openAssistantPrefs({ assistantEnabled: true });
    const lm = await screen.findByTestId("prefs-assistant-link-lmstudio");
    expect(lm).toHaveTextContent("Works with LM Studio");
    expect(screen.getByTestId("prefs-assistant-link-ollama")).toHaveTextContent("Works with Ollama");
    fireEvent.click(lm);
    await waitFor(() => expect(invoke.mock.calls.find(([n]) => n === "open_web_url")?.[1]).toEqual({ url: "https://lmstudio.ai" }));
  });

  // Florence-2 (2026-09-28): a free download on its own row after the
  // model choice (spec step 8), behind the usual consent card, and the
  // same install Preferences > Models lists.
  const florence = (installed: boolean) => ({
    id: "florence_2_base",
    installed,
    label: "Florence-2 base (what is in the picture)",
    license: "MIT (code and weights; FLD-5B training data by Microsoft, see the open-source page)",
    url: "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/vision_encoder.onnx",
    bytes: 970_082_648,
    version: "2025.05",
  });

  it("offers Florence-2 behind the consent card, and the install shows here and in Models", async () => {
    let installed = false;
    const downloads: unknown[] = [];
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: () => ({ kind: "noModels", address: "127.0.0.1:1234" }),
      smart_model_status: () => ({ florence: florence(installed) }),
      smart_model_download: (args) => {
        downloads.push(args?.model);
        installed = true;
        return null;
      },
    });
    openAssistantPrefs({ assistantEnabled: true });
    const row = await screen.findByTestId("prefs-row-assistant-florence");
    expect(row).toHaveTextContent("Lets the assistant know what is in your photograph (the sky, a face, a car) and where");
    expect(row).toHaveTextContent("nothing is sent anywhere");
    const status = await screen.findByTestId("prefs-assistant-florence-status");
    expect(status).toHaveAttribute("data-installed", "false");
    expect(status).toHaveTextContent("Not installed · 970 MB");
    // Nothing is fetched until the card's own button.
    fireEvent.click(screen.getByTestId("prefs-assistant-florence-get"));
    const card = screen.getByTestId("prefs-assistant-florence-consent");
    expect(card).toHaveTextContent("970 MB");
    expect(card).toHaveTextContent("MIT");
    expect(card).toHaveTextContent("From https://huggingface.co/onnx-community/Florence-2-base");
    expect(downloads).toEqual([]);
    fireEvent.click(screen.getByTestId("prefs-assistant-florence-later"));
    expect(screen.queryByTestId("prefs-assistant-florence-consent")).toBeNull();
    fireEvent.click(screen.getByTestId("prefs-assistant-florence-get"));
    fireEvent.click(screen.getByTestId("prefs-assistant-florence-download"));
    await waitFor(() => expect(screen.getByTestId("prefs-assistant-florence-status")).toHaveAttribute("data-installed", "true"));
    expect(downloads).toEqual(["florence_2_base"]);
    expect(screen.getByTestId("prefs-assistant-florence-status")).toHaveTextContent("Installed · 970 MB · 2025.05.");
    expect(screen.queryByTestId("prefs-assistant-florence-get")).toBeNull();
    // The same install, listed with the other models.
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    await waitFor(() =>
      expect(screen.getByTestId("prefs-model-status-florence_2_base")).toHaveTextContent("installed · 970 MB · 2025.05"),
    );
    expect(screen.queryByTestId("prefs-model-install-florence_2_base")).toBeNull();
  });

  it("an installed Florence-2 shows as installed, with no download offered", async () => {
    backend({
      assistant_records: () => ({ ...NO_RECORDS, disclaimer: ACCEPTED }),
      assistant_validate: () => ({ kind: "noModels", address: "127.0.0.1:1234" }),
      smart_model_status: () => ({ florence: florence(true) }),
    });
    openAssistantPrefs({ assistantEnabled: true });
    const status = await screen.findByTestId("prefs-assistant-florence-status");
    expect(status).toHaveAttribute("data-installed", "true");
    expect(status).toHaveTextContent("The assistant can see what is in your photograph.");
    expect(screen.queryByTestId("prefs-assistant-florence-get")).toBeNull();
    expect(called("smart_model_download")).toBe(false);
  });
});

