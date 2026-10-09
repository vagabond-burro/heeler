/** The Print section's controls: one component, mounted by Develop's
 * Print section and by the graph inspector on the Print node (The
 * report: no copies between Adjustments and the graph). Grade with
 * its time, or the split pair with theirs; the paper's Dmax and
 * base; a toner by density with its strength and crossover. Every
 * hint says what the dial makes.*/

import type { Command, NodeCard } from "../state";
import { Slider } from "./simple";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

export const TONERS: { key: string; name: string; tip: string }[] = [
  { key: "selenium", name: "Selenium", tip: "Selenium: cools and deepens the shadows first, the highlights untouched until the crossover" },
  { key: "sepia", name: "Sepia", tip: "Sepia: warms the highlights first, a brown that reaches into the midtones as the crossover rises" },
  { key: "gold", name: "Gold", tip: "Gold: a blue-black in the shadows" },
  { key: "split", name: "Split", tip: "Split: sepia in the highlights over gold in the shadows, the crossover between them" },
];

/** None, then every toner: the menu's rows. */
const TONER_CHOICES = [{ id: "", label: "None" }, ...TONERS.map((t) => ({ id: t.key, label: t.name, hint: t.tip }))];

export function PrintControls({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  const split = (node.params.split ?? 0) !== 0;
  const toner = node.textParams?.toner ?? "";
  const chosen = TONERS.find((t) => t.key === toner) ?? null;
  const about = "Toner: a color by density, not by hue band, the way a toning bath takes the silver. None leaves the print neutral";
  return (
    <div data-testid="print-block">
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <div
          className="kicker"
          data-hint="Paper: the contrast the print is made at. One grade, or the printer's split pair: a soft exposure that lays the highlights and a hard one that sets the shadows"
        >
          Paper
        </div>
        <button
          className="chip"
          data-testid="print-split"
          data-active={split || undefined}
          aria-pressed={split}
          aria-label="Split grade"
          data-hint={
            split
              ? "Split grade: Soft is the grade 0 exposure, laid from the highlights down, Hard the grade 5 exposure that builds the shadows; the two add as light. Off returns to one grade"
              : "Split grade: two exposures in place of one grade, a soft one for the highlights and a hard one for the shadows, each with its own time"
          }
          style={{ padding: "0 7px", display: "inline-flex", alignItems: "center" }}
          onClick={() => dispatch({ type: "set_param", id: node.id, param: "split", value: split ? 0 : 1 })}
        >
          {/* A print split in two: the soft half open, the hard half filled
(2026-09-15: "Replace the Split label with an icon").*/}
          <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <rect x="1" y="1" width="11" height="9" rx="1" />
            <path d="M6.5 1v9" />
            <path d="M6.5 1 L12 10 L6.5 10 Z" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
      {split ? (
        <>
          <Slider label="Soft" param="soft" node={node} dispatch={dispatch} tip="The soft exposure's time in stops, grade 0: it lays tone from the highlights down, gently everywhere; more of it is most of all more in the highlights" />
          <Slider label="Hard" param="hard" node={node} dispatch={dispatch} tip="The hard exposure's time in stops, grade 5: it builds the shadows, and a lot of it reaches the highlights too, as under an enlarger. The two add as light, so the print keeps its tonal order" />
        </>
      ) : (
        <>
          <Slider label="Grade" param="grade" node={node} dispatch={dispatch} centered={false} tip="Paper grade 0 to 5: the contrast about middle gray, 0 soft and 5 hard, 2 the normal print" />
          <Slider label="Time" param="time" node={node} dispatch={dispatch} tip="Exposure time on the paper, in stops: more time is a darker print, less a lighter one" />
        </>
      )}
      <Slider label="Dmax" param="dmax" node={node} dispatch={dispatch} centered={false} tip="The paper's deepest black as a density: about 2.1 for a glossy fiber paper, 1.7 for matte. The print's black is the paper's, not the screen's" />
      <Slider label="Base" param="base" node={node} dispatch={dispatch} tip="The paper's white: cold-toned to the left, warm-toned to the right, on every reflected value" />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        <div className="kicker" data-hint={about}>Toner</div>
        <MenuField
          testid="print-toner"
          label="Toner"
          node={node.id}
          param="toner"
          size="regular"
          hint={chosen ? chosen.tip : about}
          value={toner}
          options={TONER_CHOICES}
          fitLabels={TONER_CHOICES.map((t) => t.label)}
          onChange={(key) => {
            // A toner chosen with Toning at zero did nothing (2026-09-15:
            // "Toner doesn't seem to work"): the bath starts half taken, and
            // None puts the dial away.
            const toning = node.params.toning ?? 0;
            if (key !== "" && toning === 0) {
              dispatch({ type: "set_params", id: node.id, values: { toning: 50 }, text: { toner: key } });
            } else {
              dispatch({ type: "set_text_param", id: node.id, param: "toner", value: key });
            }
          }}
        />
      </div>
      {chosen && (
        <>
          <Slider label="Toning" param="toning" node={node} dispatch={dispatch} centered={false} tip="How far the toner has taken the print" />
          <Slider label="Crossover" param="crossover" node={node} dispatch={dispatch} centered={false} tip="The density where the toner hands over: low lets a shadow toner climb into the midtones, high keeps it to the deepest blacks; for sepia the reverse" />
        </>
      )}
    </div>
  );
}
