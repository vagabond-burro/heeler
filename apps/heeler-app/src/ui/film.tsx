/** Film, inside the black and white treatment: the stock the Tone
 * Profile develops the negative as, as a menu, with the sheet it is
 * modeled on under it. The Development row beside it is an ordinary
 * slider on the same node. Black and white films, so the block lives
 * with the treatment (2026-09-14).*/

import { FILM_STOCKS, filmStock } from "../film";
import type { Command, NodeCard } from "../state";
import { MenuField } from "./menufield";

/** None first, then every stock: the menu's rows. */
const FILM_CHOICES = [{ id: "", label: "None" }, ...FILM_STOCKS.map((s) => ({ id: s.key, label: s.name }))];

type D = React.Dispatch<Command>;

export function FilmBlock({ node, dispatch, parked = false }: {
  node: NodeCard;
  dispatch: D;
  /** the profile is bypassed on a RAW, the user's own doing, so the
   * stock's curve is off until the profile is switched back on (review
   * 2026-09-15, item 2): the row dims and says so */
  parked?: boolean;
}) {
  const key = node.textParams?.film ?? "";
  const stock = filmStock(key);
  // The help lives in the status line (2026-09-14): the label says what
  // the menu is, the menu says what is chosen, and None says what the
  // label says.
  const about = "Film: the stock the negative is developed as, its toe, its straight line, its shoulder, from the published family's shape. None is the profile's own rendering.";
  const parkedNote = " The Tone Profile is bypassed in the graph, so the stock's curve is off; switch the profile on to develop.";
  return (
    <div data-testid="film-block" data-parked={parked || undefined} style={{ margin: "2px 0 6px", opacity: parked ? 0.45 : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="kicker" data-hint={about + (parked ? parkedNote : "")}>Film</div>
        <MenuField
          testid="film-stock"
          label="Film stock"
          node={node.id}
          param="film"
          size="regular"
          hint={(stock ? `${stock.name}: modeled on ${stock.modelledOn}. A fit of the family's shape, not the sheet itself.` : about) + (parked ? parkedNote : "")}
          value={stock ? key : ""}
          options={FILM_CHOICES}
          fitLabels={FILM_CHOICES.map((o) => o.label)}
          onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param: "film", value })}
        />
      </div>
    </div>
  );
}
