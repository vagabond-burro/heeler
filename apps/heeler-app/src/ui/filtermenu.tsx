/** The Wratten filter menu, the one control in the treatment block and
 * on the conversion's node in the graph. Its help lives in the status
 * line: the label says what the menu is, the menu says what is
 * chosen, None says what the label says (2026-09-14).*/

import { WRATTEN_FILTERS, wrattenFilter } from "../filters";
import { filmStock } from "../film";
import type { Command, NodeCard } from "../state";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

export function FilterMenu({
  bw,
  nodes,
  dispatch,
  testid = "bw-filter",
  param = "filter",
  label = "Filter",
  noneLabel = "None",
  about: aboutOverride,
  trailing,
}: {
  bw: NodeCard;
  /** every node, for the stock the Film menu names on the profile */
  nodes: NodeCard[];
  dispatch: D;
  testid?: string;
  /** the node's text param this menu writes: `filter` (near) or
   * `far_filter` (idea 6, the far end of the depth map) */
  param?: "filter" | "far_filter";
  label?: string;
  /** what the empty choice means here */
  noneLabel?: string;
  /** the label's and the empty menu's status-line help */
  about?: string;
  /** a chip after the menu (the far row's View depth eye) */
  trailing?: React.ReactNode;
}) {
  const filter = wrattenFilter(bw.textParams?.[param]);
  const stock = filmStock(nodes.find((n) => n.type === "heeler.tone_profile")?.textParams?.film);
  const about =
    aboutOverride ??
    `Filter: a Wratten filter in front of the film, its transmission rather than a channel weight. Yellow to red darken the sky and lighten skin; blue and green do the reverse. None: the mixer decides${stock ? `, unless a stock is on, and ${stock.name} is` : ""}.`;
  return (
    <div data-testid={testid} style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="kicker" data-hint={about}>{label}</div>
        <MenuField
          testid={`${testid}-menu`}
          label={param === "filter" ? "Wratten filter" : "Wratten filter on the far end"}
          node={bw.id}
          param={param}
          size="regular"
          hint={
            filter
              ? `${filter.name}${param === "far_filter" ? " on the far end" : ""}: modeled on ${filter.modelledOn}${stock ? `, on ${stock.name}'s sensitivity` : ", panchromatic"}. The mixer stands down.`
              : about
          }
          value={filter ? filter.key : ""}
          options={[{ id: "", label: noneLabel }, ...WRATTEN_FILTERS.map((f) => ({ id: f.key, label: f.name }))]}
          fitLabels={[noneLabel, ...WRATTEN_FILTERS.map((f) => f.name)]}
          onChange={(value) => dispatch({ type: "set_text_param", id: bw.id, param, value })}
        />
        {trailing}
      </div>
    </div>
  );
}
