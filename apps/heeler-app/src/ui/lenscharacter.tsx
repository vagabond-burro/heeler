import { usePickSessions } from "../picksession";
// The Lens Character block: a vintage lens as one menu over the optical
// sections. It has no dials and no node; choosing a lens writes Depth
// of Field, Lens Correction, Vignette, Halation, Detail, Recolor and
// Lens Flare together in one undo step, and each stays its own section
// afterwards. The photograph's lens name can suggest one; it is never
// applied by itself.
//
// The two doors beside the summary line (2026-09-04): the apply never
// writes aperture or a light - aperture is a photograph decision, not a
// lens fact, and a non-zero write would defocus a frame shot sharp - so
// where the character cannot show without one (bokeh needs an open
// aperture, flare needs a flaring rig light), an explicit chip offers
// it: one click, one undo step of its own.

import React, { useEffect, useState } from "react";
import { depthAt, depthMap, imageMetadata, sampleImage } from "../bridge";
import {
  LENS_CHARACTERS,
  characterApertureDoor,
  characterFlareDoor,
  suggestLensCharacter,
  toolNode,
  type Command,
  type State,
} from "../state";
import { type KeyLight } from "./keylightgizmo";
import { logMsg } from "../log";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

export function LensCharacterBlock({ state, dispatch }: { state: State; dispatch: D }) {
  const picks = usePickSessions(state, dispatch);
  const dof = toolNode(state, "dof");
  const current = dof?.textParams?.character ?? "";
  const chosen = LENS_CHARACTERS.find((c) => c.id === current);
  const [suggested, setSuggested] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void imageMetadata(state, state.activeImage)
      .then((m) => {
        if (live) setSuggested(suggestLensCharacter(m?.lens ?? null));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeImage]);
  const closed = state.sectionsClosed.includes("Lens Character");
  // The doors (see the header): each shows only while the character
  // cannot be seen without it, and each is one explicit click.
  const apertureDoor = characterApertureDoor(state);
  const flareDoor = characterFlareDoor(state);
  const openAperture = () => {
    const ch = apertureDoor?.character;
    const face = apertureDoor?.face;
    const dofNode = toolNode(state, "dof");
    if (!ch || !face || !dofNode) return;
    const session = picks.start("aperture", {
      aim: (v) => {
        const door = characterApertureDoor(v);
        return [door?.character.id, door?.face, v.nodes.some((n) => n.id === dofNode.id)];
      },
      settings: (v) => v.nodes.find((n) => n.id === dofNode.id)?.params,
    });
    void (async () => {
      // Focus: the dial already holds the depth under the last Set
      // focus pick, so a picked focus stays. Never picked (still 0):
      // the plane's median, which needs the plane, computed through
      // the same bridge call the DepthRunner makes, so an existing
      // raster costs a file stat. On the second face this is the whole
      // click: the aperture is already open.
      let focus: number | undefined;
      if (((dofNode.params.focus as number) ?? 0) === 0) {
        const clearBusy = session.busy("DEPTH · reading the scene's distances");
        try {
          await depthMap(session.state());
          if (!session.stillMine()) return;
          const steps = [0.2, 0.4, 0.6, 0.8];
          const reads = await Promise.all(steps.flatMap((y) => steps.map((x) => depthAt(session.state(), x, y))));
          if (!session.stillMine()) return;
          reads.sort((a, b) => a - b);
          focus = Math.round(reads[Math.floor(reads.length / 2)] * 100);
        } catch {
          // No plane and no model: the write below is what wakes the
          // DepthRunner, whose consent card carries the download. The
          // focus waits for the plane; Set focus picks it after.
          focus = undefined;
        } finally {
          clearBusy();
        }
      }
      if (!session.stillMine()) return;
      if (face === "focus" && focus === undefined) {
        logMsg("info", "Focus: the depth plane is not there yet; the chip stays until it is, or Set focus picks one");
        return;
      }
      session.dispatch({
        type: "set_params",
        id: dofNode.id,
        values: {
          ...(face === "aperture" ? { aperture: ch.aperture } : {}),
          ...(focus !== undefined ? { focus } : {}),
        },
      });
      logMsg(
        "info",
        face === "aperture"
          ? `Open aperture: ${ch.name} wide open (${ch.aperture})${focus !== undefined ? `, focus at the plane's median ${focus}` : ", focus waits for the plane"}`
          : `Focus at the plane's median: ${focus}`,
      );
    })().finally(session.cancel);
  };
  const addFlaringLight = () => {
    const ch = flareDoor;
    if (!ch) return;
    const session = picks.start("flare", {
      aim: (v) => characterFlareDoor(v)?.id,
      settings: (v) => {
        const dof = toolNode(v, "dof");
        return [dof?.textParams?.character, dof?.params];
      },
    });
    void (async () => {
      // The light belongs on the frame's brightest point: a coarse luma
      // scan of the current preview. Null samples (no engine behind the
      // bridge) leave the center.
      let px = 0.5;
      let py = 0.5;
      let best = -1;
      const steps = [0.1, 0.3, 0.5, 0.7, 0.9];
      const samples = await Promise.all(steps.flatMap((y) => steps.map((x) => sampleImage(session.state(), x, y, 0.03))));
      if (!session.stillMine()) return;
      samples.forEach((sample, i) => {
        if (sample && sample.luma > best) {
          best = sample.luma;
          px = steps[i % steps.length];
          py = steps[Math.floor(i / steps.length)];
        }
      });
      // A point lamp flares where it stands. Strength 0: the door adds
      // a FLARE, not a relight, so the photograph's lighting stays
      // exactly as it was. Flare strength 100, the rig's own default:
      // no source ranks the lenses' flare strength against one another.
      const light: KeyLight = {
        kind: "point",
        azimuth: 45,
        elevation: 45,
        strength: 0,
        on: true,
        color: "#ffffff",
        tx: 0.5,
        ty: 0.5,
        px,
        py,
        depth: 30,
        range: 50,
        sun_depth: 0,
        sun_reach: 50,
        flare: true,
        flare_strength: 100,
      };
      // One command, one undo step: it builds Depth Lighting if the
      // photograph has none, then puts the light on both rig nodes.
      session.dispatch({ type: "add_character_flare_light", light });
      logMsg("info", `Flaring light added for ${ch.name} at the frame's brightest point`);
    })().catch((err) => {
      if (session.stillMine()) logMsg("warn", `Flaring light: ${err}`);
    }).finally(session.cancel);
  };
  return (
    <div data-testid="lens-character" data-section="Lens Character" style={{ borderBottom: "1px solid var(--line-1)" }}>
      {/* The same header every section wears: the chevron and the title
are the control, closed by default ("It should be
a section that has to be expanded/opened").*/}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
        <button
          data-testid="collapse-lens-character"
          data-open={!closed}
          aria-expanded={!closed}
          aria-label="Lens Character section"
          data-hint={`A vintage lens as one setting across the optical sections${closed ? " · click to open" : " · click to collapse"}`}
          onClick={() => dispatch({ type: "toggle_section", title: "Lens Character" })}
          style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, alignSelf: "stretch" }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth="2.6"
            style={{ transform: closed ? "rotate(-90deg)" : "none", transition: "transform .12s", flex: "none" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".10em", textTransform: "uppercase", color: "#c7ccd0" }}>
            Lens Character
          </div>
        </button>
      </div>
      {!closed && (
        <div
          style={{ padding: "0 12px 10px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div className="kicker">Lens</div>
            <MenuField
              testid="lens-character-menu"
              label="Lens character"
              hint="A vintage lens written across Depth of Field, Lens, Vignette, Halation, Detail, Recolor and Lens Flare in one undo step; every section stays yours to edit"
              size="regular"
              value={current}
              placeholder={current ? "Custom" : "Choose a lens…"}
              options={LENS_CHARACTERS.map((c) => ({ id: c.id, label: `${c.name}${c.id === suggested ? " · suggested" : ""}` }))}
              onChange={(id) => {
                const c = LENS_CHARACTERS.find((x) => x.id === id);
                if (!c) return;
                dispatch({ type: "apply_lens_character", id: c.id });
                logMsg("info", `Lens character applied: ${c.name} (${Object.keys(c.writes).join(", ")})`);
              }}
            />
          </div>
          <div data-testid="lens-character-summary" style={{ fontSize: 11.25, color: "var(--text-faint)", lineHeight: 1.5 }}>
            {chosen
              ? `${chosen.name}: ${chosen.hint}. Set ${Object.keys(chosen.writes).join(", ")}.`
              : "Pick a lens and its character is written across the optical sections. Nothing is applied until you choose."}
          </div>
          {(apertureDoor || flareDoor) && (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {apertureDoor && (
                <button
                  className="chip"
                  data-testid={apertureDoor.face === "aperture" ? "lens-character-open-aperture" : "lens-character-focus-median"}
                  data-hint={
                    apertureDoor.face === "aperture"
                      ? `Write ${apertureDoor.character.name}'s wide-open aperture (${apertureDoor.character.aperture}) into Depth of Field, with the focus at the depth plane's median unless you already picked one; computes the depth plane first if the photograph has none, and a one-time model download asks before fetching`
                      : "The aperture is open and the focus never landed: write the depth plane's median as the focus, one click, or pick one with Set focus"
                  }
                  style={{ fontSize: 9, padding: "0 6px" }}
                  onClick={openAperture}
                >
                  {apertureDoor.face === "aperture" ? "Open aperture" : "Focus at the plane's median"}
                </button>
              )}
              {flareDoor && (
                <button
                  className="chip"
                  data-testid="lens-character-add-flare"
                  data-hint={`Add one light to the Depth Lighting rig at the frame's brightest point with its flare on, building Depth Lighting first if the photograph has none; it does not relight the scene, and undo takes it back on its own`}
                  style={{ fontSize: 9, padding: "0 6px" }}
                  onClick={addFlaringLight}
                >
                  Add a flaring light
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
