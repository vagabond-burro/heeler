/** The Grain section's Film row: with a stock on under the black and
 * white treatment, one chip sets the Grain dials as that film would
 * have them at its development, and names both. One component,
 * mounted by Develop's Grain section and by the graph inspector on
 * the Grain node (no copies between Adjustments and the
 * graph). Nothing to show without a stock: the row is the film's
 * word, and there is no film.*/

import { filmStock, grainFromFilm } from "../film";
import { GRAIN_FORMATS, type Command, type NodeCard } from "../state";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

/** Enlargement: the negative's format against the print, and, on a
 * graph saved before grain was a share of the frame, the one click
 * that makes it one. One component for Develop's Grain section and
 * the graph's Grain node.*/
export function GrainFrameRow({ grain, dispatch }: { grain: NodeCard; dispatch: D }) {
  const byFrame = (grain.params.by_frame ?? 0) !== 0;
  const format = grain.textParams?.format ?? "35mm";
  return (
    <div data-testid="grain-frame" style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0 6px", flexWrap: "wrap" }}>
      {byFrame ? (
        <>
          {/* A menu, at a size that reads (2026-09-15: "make the format a
dropdown, and scale up the font of the format values by 1.25x").*/}
          <div
            className="kicker"
            data-hint="Format: the negative's size against the print. A bigger negative is enlarged less for the same print, so its grain is a smaller share of the frame; 35mm is the reference"
          >
            Format
          </div>
          <MenuField
            testid="grain-format"
            label="Negative format"
            node={grain.id}
            param="format"
            size="regular"
            value={format}
            options={GRAIN_FORMATS}
            fitLabels={GRAIN_FORMATS.map((f) => f.label)}
            hint={
              format === "35mm"
                ? "35mm: the reference, the grain as Grain size sets it"
                : format === "4x5"
                  ? "4x5: a sheet film, enlarged little; the grain a quarter of 35mm's share of the frame"
                  : `${format}: a roll-film negative, enlarged less than 35mm; a finer grain on the print`
            }
            onChange={(value) => dispatch({ type: "set_text_param", id: grain.id, param: "format", value })}
          />
        </>
      ) : (
        <button
          className="chip"
          data-testid="grain-by-frame"
          aria-label="Size the grain by the frame"
          data-hint="This photograph's grain is sized in the render's pixels, the old way, so a preview showed it coarser than the export. Size it by the frame instead: a 4000 px short side is the reference, and every other size follows it. Very fine grain fades below a pixel, including at the reference size. Undoable"
          style={{ padding: "0 8px", display: "inline-flex", alignItems: "center", fontSize: 9 }}
          onClick={() => dispatch({ type: "set_param", id: grain.id, param: "by_frame", value: 1 })}
        >
          Size by the frame
        </button>
      )}
    </div>
  );
}

export function GrainFilmRow({ grain, nodes, dispatch }: { grain: NodeCard; nodes: NodeCard[]; dispatch: D }) {
  const mono = nodes.some((n) => n.type === "heeler.black_white" && n.enabled && (n.params.amount ?? 0) > 0);
  const profile = nodes.find((n) => n.type === "heeler.tone_profile");
  const stock = mono ? filmStock(profile?.textParams?.film) : null;
  if (!stock) return null;
  const n = profile?.params.development ?? 0;
  const preset = grainFromFilm(stock.key, n);
  if (!preset) return null;
  const dev = n === 0 ? "N" : n > 0 ? `N+${n}` : `N${n}`;
  return (
    <div data-testid="grain-film" style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 6px" }}>
      <div
        className="kicker"
        data-hint="Film: the grain the stock chosen in Color's treatment would lay down at its development, as a starting point for the dials below"
      >
        Film
      </div>
      <button
        className="chip"
        data-testid="grain-film-set"
        aria-label={`Set the grain from ${stock.name} at ${dev}`}
        data-hint={`Set Grain amount, size, character and the tonal bands as ${stock.name} would have them at ${dev}: a push coarsens and strengthens the grain, a pull the reverse. A starting point, the film's word and not a rule`}
        style={{ padding: "1px 9px", display: "inline-flex", alignItems: "center", fontSize: 11.25 }}
        onClick={() => dispatch({ type: "set_params", id: grain.id, values: preset.values, text: preset.text })}
      >
        {stock.name} at {dev}
      </button>
    </div>
  );
}
