// Preferences > Assistant, in the owner's order: a switch, off by
// default, whose first use shows the notice and records it; the server
// address, prefilled with LM Studio's; Validate, answered in words; the
// model list from the server, tested models marked and any other asking
// once for an acknowledgment; the apps it works with; and Florence-2,
// the optional download that lets the assistant see what is in the
// picture (step 8, after the model choice), with the usual consent card.
//
// The assistant only answers questions; anything that would change the
// edit goes through the reducer. The notice and the untested-model
// acknowledgment are asked on every copy.

import React, { useEffect, useRef, useState } from "react";
import {
  assistantAcceptDisclaimer,
  assistantAcknowledgeModel,
  assistantRecords,
  assistantValidate,
  onModelsChanged,
  openWebUrl,
  smartModelDownload,
  smartModelStatus,
  type AssistantRecords,
  type AssistantValidation,
  type SmartModelStatus,
} from "../bridge";
import { ModelConsentCard } from "./modelconsent";
import {
  ACKNOWLEDGMENT_TEXT,
  DISCLAIMER_TEXT,
  DISCLAIMER_VERSION,
  WHAT_IS_SENT,
  TESTED_MODEL_LIST,
  WORKS_WITH,
  modelKey,
  validationWords,
} from "../assistant";
import type { Command, State } from "../state";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

export type AssistantRowId = "assistant-enable" | "assistant-server" | "assistant-model" | "assistant-works-with" | "assistant-florence";

/** A notice standing in the panel until answered: a tinted block, no
 * frame (the no-borders rule), the words first and two choices. */
function Notice({
  testid,
  heading,
  children,
  accept,
  decline,
}: {
  testid: string;
  heading: string;
  children: React.ReactNode;
  accept: { label: string; hint: string; onClick: () => void };
  decline: { label: string; hint: string; onClick: () => void };
}) {
  return (
    <div
      data-testid={testid}
      role="alertdialog"
      aria-label={heading}
      style={{ background: "var(--bg-app)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9, maxWidth: 560 }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".12em", color: "var(--text-hi)" }}>{heading}</div>
      <div style={{ fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.55 }}>{children}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          className="chip"
          data-testid={`${testid}-accept`}
          data-hint={accept.hint}
          style={{ borderColor: "var(--accent)", color: "var(--accent)", fontSize: 11, padding: "2px 9px" }}
          onClick={accept.onClick}
        >
          {accept.label}
        </button>
        <button className="chip" data-testid={`${testid}-decline`} data-hint={decline.hint} style={{ fontSize: 11, padding: "2px 9px" }} onClick={decline.onClick}>
          {decline.label}
        </button>
      </div>
    </div>
  );
}

/** Florence-2's row: the
 * same model, status and download Preferences > Models lists, so an
 * install in either place shows in both. DOWNLOAD opens the consent
 * card every model gets, naming its size, license and source before a
 * byte is fetched. */
export function FlorenceRow() {
  const [model, setModel] = useState<SmartModelStatus | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [asking, setAsking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => onModelsChanged(() => setEpoch((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    void smartModelStatus()
      .then((m) => { if (live) setModel(m?.florence ?? null); })
      .catch(() => { if (live) setModel(null); });
    return () => { live = false; };
  }, [epoch]);
  if (!model) return null;
  if (model.installed) {
    return (
      <div data-testid="prefs-assistant-florence-status" data-installed="true" style={{ fontSize: 13, color: "var(--text-body)", lineHeight: 1.5 }}>
        Installed {"\u00b7"} {Math.round(model.bytes / 1e6)} MB {"\u00b7"} {model.version}. The assistant can see what is in your photograph.
      </div>
    );
  }
  const download = () => {
    setDownloading(true);
    setProblem(null);
    void smartModelDownload(model.id)
      .then(() => setAsking(false))
      .catch((e) => setProblem(`The download did not finish: ${String(e)}`))
      .finally(() => setDownloading(false));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="chip"
          data-testid="prefs-assistant-florence-get"
          data-active={asking || undefined}
          disabled={downloading}
          data-hint="Downloads Florence-2 once you agree; the card below names its size, license and source first"
          style={{ fontSize: 11, padding: "2px 9px" }}
          onClick={() => setAsking((a) => !a)}
        >
          {downloading ? "DOWNLOADING\u2026" : "DOWNLOAD"}
        </button>
        <span data-testid="prefs-assistant-florence-status" data-installed="false" style={{ fontSize: 12, color: "var(--text-ghost)" }}>
          Not installed {"\u00b7"} {Math.round(model.bytes / 1e6)} MB
        </span>
      </div>
      {asking && (
        <ModelConsentCard
          title="DOWNLOAD FLORENCE-2 FOR THE ASSISTANT"
          model={model}
          testid="prefs-assistant-florence"
          downloading={downloading}
          place={{ fontSize: 13, maxWidth: "100%" }}
          onDownload={download}
          secondary={{ label: "NOT NOW", testid: "prefs-assistant-florence-later", onClick: () => setAsking(false) }}
        />
      )}
      {problem && (
        <div data-testid="prefs-assistant-florence-problem" style={{ fontSize: 13, color: "var(--warn)", lineHeight: 1.5 }}>
          {problem}
        </div>
      )}
    </div>
  );
}

function formatDate(unixTime: number): string {
  return new Date(unixTime * 1000).toISOString().slice(0, 10);
}

/** The tested models as a two-column list, model then the app that names
 * it, showing five rows and scrolling past that (2026-09-29). Rows are
 * 20 px, so five are 100 px; no borders, the header in the kicker style
 * the panel's other labels use.*/
const TESTED_ROW = 20;
function TestedModels() {
  return (
    <div data-testid="prefs-assistant-tested-list" role="table" aria-label="Models tested with Heeler" style={{ fontSize: 12 }}>
      <div role="row" style={{ display: "grid", gridTemplateColumns: "1fr auto", columnGap: 16, height: TESTED_ROW, alignItems: "center" }}>
        <span role="columnheader" className="kicker">Model</span>
        <span role="columnheader" className="kicker" style={{ minWidth: 70 }}>Platform</span>
      </div>
      <div
        data-testid="prefs-assistant-tested-rows"
        role="rowgroup"
        style={{ maxHeight: TESTED_ROW * 5, overflowY: "auto" }}
      >
        {TESTED_MODEL_LIST.map((m) => (
          <div
            key={m.model}
            role="row"
            data-testid="prefs-assistant-tested-row"
            style={{ display: "grid", gridTemplateColumns: "1fr auto", columnGap: 16, height: TESTED_ROW, alignItems: "center" }}
          >
            <span role="cell" className="tnum" style={{ color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.model}>
              {m.model}
            </span>
            <span role="cell" style={{ color: "var(--text-ghost)", minWidth: 70 }}>{m.platform}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AssistantSettings({
  state,
  dispatch,
  block,
}: {
  state: State;
  dispatch: D;
  /** Draws one row the way every other preference is drawn. */
  block: (id: AssistantRowId, control: React.ReactNode) => React.ReactNode;
}) {
  const prefs = state.prefs;
  const setPref = (p: Partial<State["prefs"]>) => dispatch({ type: "set_prefs", prefs: p });
  const [records, setRecords] = useState<AssistantRecords | null>(null);
  const [askNotice, setAskNotice] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ address: string; v: AssistantValidation } | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // On only with the notice on record here: a catalog carried to another
  // computer brings the switch but not this installation's record, and
  // the notice is asked again there.
  const accepted = records?.disclaimer?.version === DISCLAIMER_VERSION;
  const on = prefs.assistantEnabled && (records === null || accepted);

  useEffect(() => {
    let live = true;
    void assistantRecords()
      .then((r) => { if (live) setRecords(r); })
      .catch((e) => { if (live) setProblem(String(e)); });
    return () => { live = false; };
  }, []);

  const acknowledged = (id: string) =>
    !!records?.acknowledged.some((a) => modelKey(a.model) === modelKey(id));

  const validate = async (address = prefs.assistantAddress) => {
    setChecking(true);
    setProblem(null);
    try {
      const v = await assistantValidate(address);
      setResult({ address, v });
      // The saved model still listed, and allowed, keeps the Console tab;
      // anything else waits for a model to be picked.
      const still = v.kind === "connected" ? v.models.find((m) => m.id === prefs.assistantModel) : undefined;
      if (still && (still.tested || acknowledged(still.id))) {
        setPref({ assistantValidated: address });
      } else if (prefs.assistantValidated) {
        setPref({ assistantValidated: "" });
      }
    } catch (e) {
      setResult(null);
      setProblem(String(e));
    } finally {
      setChecking(false);
    }
  };

  // Checked when the assistant is enabled, and when this tab opens on an
  // enabled assistant: never with a dialog.
  const checkedOnce = useRef(false);
  useEffect(() => {
    if (!on || !records || checkedOnce.current) return;
    checkedOnce.current = true;
    void validate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, records]);

  const flip = () => {
    if (on) {
      setPref({ assistantEnabled: false });
      setAskNotice(false);
      return;
    }
    if (accepted) setPref({ assistantEnabled: true });
    else setAskNotice(true);
  };

  const acceptNotice = async () => {
    try {
      const a = await assistantAcceptDisclaimer();
      setRecords((r) => (r ? { ...r, disclaimer: a } : r));
      setAskNotice(false);
      setPref({ assistantEnabled: true });
    } catch (e) {
      setProblem(`The notice could not be recorded, so the assistant stays off: ${String(e)}`);
    }
  };

  const useModel = (id: string, address: string) => {
    setPref({ assistantModel: id, assistantValidated: address });
    setPendingModel(null);
  };

  const pick = (id: string) => {
    if (!result || result.v.kind !== "connected") return;
    const m = result.v.models.find((x) => x.id === id);
    if (!m) return;
    if (m.tested || acknowledged(id)) useModel(id, result.address);
    else setPendingModel(id);
  };

  const acknowledge = async (id: string) => {
    if (!result) return;
    try {
      const list = await assistantAcknowledgeModel(id);
      setRecords((r) => (r ? { ...r, acknowledged: list } : r));
      useModel(id, result.address);
    } catch (e) {
      setProblem(`The acknowledgment could not be recorded: ${String(e)}`);
    }
  };

  const connected = result?.v.kind === "connected" && result.address === prefs.assistantAddress ? result.v : null;
  const models = connected ? connected.models : [];
  const savedListed = models.some((m) => m.id === prefs.assistantModel);

  return (
    <>
      {block(
        "assistant-enable",
        <div className="pstack" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div
            className="toggle"
            data-on={on}
            role="switch"
            aria-checked={on}
            data-testid="prefs-assistant-enable"
            aria-label="Assistant"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
            }}
            data-hint={
              on
                ? "Turns the assistant off and hides its Console tab; the address and model are kept"
                : "Turns the assistant on; the first time, you accept a short notice"
            }
            onClick={flip}
          >
            <div className="dot" />
          </div>
          {askNotice && (
            <Notice
              testid="assistant-notice"
              heading="BEFORE THE ASSISTANT IS ON"
              accept={{ label: "ACCEPT AND TURN ON", hint: "Records that you accepted this notice, with today's date, and turns the assistant on", onClick: () => void acceptNotice() }}
              decline={{ label: "NOT NOW", hint: "Leaves the assistant off; nothing is recorded", onClick: () => setAskNotice(false) }}
            >
              <p style={{ margin: 0 }}>{DISCLAIMER_TEXT}</p>
              <p style={{ margin: "8px 0 0", color: "var(--text-faint)" }}>{WHAT_IS_SENT}</p>
            </Notice>
          )}
          {on && records?.disclaimer && (
            <div data-testid="assistant-notice-record" style={{ fontSize: 12, color: "var(--text-ghost)" }}>
              Notice accepted {formatDate(records.disclaimer.unixTime)}.
            </div>
          )}
        </div>,
      )}
      {on && (
        <>
          {block(
            "assistant-server",
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  data-testid="prefs-assistant-address"
                  aria-label="Server address"
                  data-hint="Sets where your model server listens; Validate checks it is on this computer or your home network"
                  value={prefs.assistantAddress}
                  spellCheck={false}
                  onChange={(e) => setPref({ assistantAddress: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") void validate(); }}
                  style={{ flex: 1, minWidth: 0, background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13, padding: "4px 7px", outline: "none" }}
                />
                <button
                  className="chip"
                  data-testid="prefs-assistant-validate"
                  data-hint="Checks the address is on this computer or your home network and asks the server which models it has"
                  disabled={checking}
                  style={{ fontSize: 11, padding: "2px 9px", flex: "none" }}
                  onClick={() => void validate()}
                >
                  {checking ? "CHECKING" : "VALIDATE"}
                </button>
              </div>
              {result && result.address === prefs.assistantAddress && (
                <div
                  data-testid="prefs-assistant-status"
                  data-kind={result.v.kind}
                  style={{ fontSize: 13, lineHeight: 1.5, color: result.v.kind === "connected" ? "var(--text-body)" : "var(--warn)" }}
                >
                  {validationWords(result.v)}
                </div>
              )}
              {problem && (
                <div data-testid="prefs-assistant-problem" style={{ fontSize: 13, color: "var(--warn)", lineHeight: 1.5 }}>
                  {problem}
                </div>
              )}
            </div>,
          )}
          {block(
            "assistant-model",
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <MenuField
                testid="prefs-assistant-model"
                label="Model"
                hint={models.length ? "Chooses the model that answers; a model Heeler has not tested asks you to acknowledge it once" : "Validate the server first; its models fill this list"}
                size="regular"
                disabled={models.length === 0}
                value={savedListed ? prefs.assistantModel : ""}
                placeholder={models.length ? "Pick a model" : prefs.assistantModel ? `${prefs.assistantModel} (Validate to change)` : "Validate to list the server's models"}
                options={models.map((m) => ({ id: m.id, label: m.tested ? `${m.id} (Tested with Heeler)` : m.id }))}
                onChange={pick}
              />
              {pendingModel && (
                <Notice
                  testid="assistant-acknowledge"
                  heading="NOT TESTED WITH HEELER"
                  accept={{ label: "USE THIS MODEL", hint: "Records your acknowledgment for this model, with today's date, and uses it", onClick: () => void acknowledge(pendingModel) }}
                  decline={{ label: "PICK ANOTHER", hint: "Leaves the model as it was; nothing is recorded", onClick: () => setPendingModel(null) }}
                >
                  <p style={{ margin: 0, color: "var(--text-hi)" }}>{pendingModel}</p>
                  <p style={{ margin: "6px 0 0" }}>{ACKNOWLEDGMENT_TEXT}</p>
                </Notice>
              )}
              {prefs.assistantModel && prefs.assistantValidated === prefs.assistantAddress && (
                <div data-testid="prefs-assistant-ready" style={{ fontSize: 12, color: "var(--text-ghost)" }}>
                  {prefs.assistantModel} answers in the Console's Assistant tab.
                </div>
              )}
            </div>,
          )}
          {block(
            "assistant-works-with",
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {WORKS_WITH.map((app) => (
                  <button
                    key={app.name}
                    className="chip"
                    data-testid={`prefs-assistant-link-${app.name.toLowerCase().replace(/\s+/g, "")}`}
                    data-hint={`Opens ${app.url} in your browser`}
                    style={{ fontSize: 11, padding: "2px 9px" }}
                    onClick={() => void openWebUrl(app.url)}
                  >
                    Works with {app.name}
                  </button>
                ))}
              </div>
              <div data-testid="prefs-assistant-tested" style={{ fontSize: 12, color: "var(--text-ghost)", lineHeight: 1.5 }}>
                Tested with Heeler, by the name each app shows. Any other model asks once for the acknowledgment.
              </div>
              <TestedModels />
            </div>,
          )}
          {block("assistant-florence", <FlorenceRow />)}
        </>
      )}
    </>
  );
}
