# Recolor

Recolor routes one color component into another with editable curves. It supports precise transformations that are difficult to express with a standard hue slider. On an adjustment layer it follows the layer's mask, and its Depth row reads the same plane the depth tools' layers read.

The editor's cells select a source and destination relationship, such as hue over luminance. Add and move curve points to describe how the source dimension changes across the destination range. To change one color into another, raise or lower the hue-to-hue curve at that color's hue: it moves a color up to 60 degrees around the hue circle, so a red car can turn orange or magenta, though not all the way to blue.

## Looks

A **Preview a look** menu sits at the top of the section when it is open, each look a whole Recolor setting, chosen to show what the routing grid can do:

- **Cool Distance** cools and quiets color the farther away it is, the way real air does, read from the depth map.
- **Warm Subject** warms and enriches whatever is nearest the camera and leaves the background as it was, read from the depth map.
- **Teal and Orange** turns greens and blues toward teal, keeps skin tones warm, and splits the tones cool in the shadows and warm in the highlights.
- **Autumn** swaps the greens for golds and oranges.
- **Muted Palette** quiets the loudest colors most and the gentle ones least, a soft, printed look.
- **Deep Skies** deepens and darkens the blues, so a pale sky turns rich without touching the rest.

Open the menu and point at a look (or walk the list with the arrow keys): the viewer shows it on your own photograph, and closing the menu puts the photograph back exactly as it was. Nothing is saved, nothing goes into undo, and the look never reaches an export, a bake, a Take, copied edits or the thumbnail. Click a look to apply it: it replaces every curve and surface in the section and switches Recolor on, as one undo step.

Cool Distance and Warm Subject read the photograph's depth map, the one the depth tools read. Until the photograph has one they are dimmed in the menu, and the section says what they need: **Read depth** reads it once (a few seconds with the depth model), and when the depth model is not installed, **Get the model** opens **Preferences > Models**. A photograph that carries its own depth pass (an OpenEXR with Z or mist) needs no model.

The menu steps aside while an adjustment layer is selected, and the Recolor node in the Graph inspector offers the same menu.

## Split toning

Recolor took over from the old Split Tone section: a split tone here is a curve along brightness, with as many zones as you place points, where Split Tone had two.

1. In the routing grid choose **Lum** under BY, so the plot's axis runs from the shadows on the left to the highlights on the right.
2. Under ADJUST choose **Temp**, and pull the curve down over the shadows to cool them and up over the highlights to warm them. **Tint** under the same BY adds green or magenta the same way.
3. To turn the colors already in the picture by brightness instead, choose **Hue** under ADJUST: the curve rotates hues in the shadows one way and in the highlights another. This cell skips the Neutral guard on purpose, so a nearly neutral shadow still takes the turn.

The **Teal and Orange** look is a split tone made this way: apply it and read its curves. For the quick version with one color wheel for the shadows and one for the highlights, use [Color Wheels](color-wheels.md#split-toning).

## Beyond hue, saturation and luminance

- **Depth** is a fourth thing to select by. Its axis runs from NEAR to
  FAR across the photograph's depth plane, the same one the Fog, Key
  Light and Depth of Field tools read, so a curve can cool and soften
  the distance, or pull a subject forward, without a mask. The first
  point you move on a Depth cell asks Heeler to compute the plane if it
  has not already, and the depth tools' View depth eye sits on the
  Layout row while a Depth cell is up. The plot's backdrop is the depth
  map as View depth shows it, white near and black far, with NEAR and
  FAR at the ends, so a point over black grades what is black in the
  map. This runs the other way from a luminance ramp on purpose: the
  axis is distance, read the way a scene is read, near to far, and the
  Depth row is not the map's luminance that a layer's Depth block edits.
- **Around** selects by the hue of a color's surroundings rather than
  its own, averaged over the **Around reach** dial (a percentage of the
  frame's short side). The eye judges a color by what sits next to it,
  so "warm the skin only where it sits against a cool background" is
  one curve here. Neutral surroundings have no hue, so a color in a
  gray setting is left alone.
- **Hue × Lum** selects by both at once, as a grid instead of a curve:
  hue across, brightness up, one output. Drag a cell up or down to set
  it; Shift snaps, Option-click (Alt-click on Windows) or double-click clears. Where two curves
  multiply their separate answers, a cell answers the pair directly:
  protect skin in the highlights and lift the same hue in the shadows
  in two cells.
- **Mask** selects by a mask's coverage: choose any mask in the
  photograph (a layer's, a Color Set's, the selection) and the axis
  runs from 0 outside it to 100 inside; the mask is chosen from a menu
  on the Layout row. The point of it is the fringe:
  a half-covered edge pixel gets its own treatment, which "mask, then
  adjust" can never give it.
- **Pastel** is a new thing to adjust. Where Lum brightens a color at
  the same strength (a red stays red as it lightens), Pastel walks it
  toward white, the way a painter mixes white into a pigment: a red
  becomes pink. Negative values walk the other way, deeper and
  stronger. Pastel keeps the hue exactly.
- **Temp**, **Tint** and **Vibrance** are the Color section's dials
  as outputs, so they can be driven by anything on the BY side: cool
  the far plane by depth, warm only the skin hues, pull magenta out of
  the shadows by luminance, or lift vibrance where the surroundings are
  muted. Temp positive warms, Tint positive is magenta, and Vibrance
  raises the muted colors first and leaves the vivid alone.
- **Spread** is a second reading of the Hue → Hue curve, chosen beside
  it. Shift turns hues by the curve's degrees. Spread reads the curve
  as hue contrast: where it is high, neighboring hues are pulled apart
  (+100 doubles their separation); where it is low they are merged
  toward one another, and the picture as a whole does not turn. "Merge
  the oranges, spread the greens" is one curve.
- **Sat → Hue** turns a color by how saturated it is: vivid colors one
  way, muted ones another, grays not at all. One curve for the way film
  dyes drift with density.
- **Match** places an intent instead of a point. Arm it beside the
  picker, click the color you have, then click the color it should
  become. Heeler writes the hue, saturation and exposure points that
  carry the first to the second, and the curves stay yours to edit.
  Escape between the two clicks drops the pin.

## Placing points precisely

- The **X** and **Y** fields under each curve show the selected point and follow it while you drag; type a value and press Enter to place it exactly.
- Hold **Shift** while dragging to snap to each axis's own unit: 10° on hue, 10 points on saturation, quarter stops on the EV axis, on both the BY and ADJUST sides.
- Hold **Option** or **Cmd** (**Alt** on Windows) while dragging to lock the drag to its dominant direction, exactly as in Relight, and combine it with Shift to step along one axis only.
- The **Layout** menu is shaped by the BY axis: hue and Around offer every 60° or 30°, saturation every 50, 25, or 10, depth and mask every 25 or 10, and the EV axis borrows Relight's layouts.

## Copying a curve

The copy and paste buttons sit above the plot at its right corner, across from the Layout menu. **Copy** takes the ADJUST curve on screen; choose another ADJUST under the same BY and **Paste** replaces its curve with the copy, in one undo step. Hue to Sat copied onto Hue to Lum, for example, carries the same shape across the hues.

- Copying works between ADJUST curves only. The BY row sets the axis a curve is drawn along, so a curve drawn by Hue pastes onto another Hue row and not onto Depth or Sat; Paste is dimmed and says why when the BY differs.
- The shape is kept as the plot showed it. Each ADJUST has its own range (Hue turns up to 60°, Sat and the others go to 100%, Lum to 2 stops), so a point halfway up the Sat plot lands halfway up the Lum plot.
- Recolor's clipboard is its own: a curve copied in Curves never pastes here, or the other way round. The Hue × Lum grid has no curve and no copy.

## Controls

- **Neutral guard** keeps grays and near-grays out of the Hue rows. A gray's hue is mostly noise, so without the guard a Hue curve speckles clouds, haze and shadows. Under the slider, a strip shows how colorful the photograph is, from gray on the left to vivid on the right, with the guard's fade drawn over it: the bars it holds back are dimmed, and a short line says how much of the photograph the Hue rows reach. Point at the line for the whole story in the status line.
- **Smoothing** blends changes across the routed range.
- **Picker** samples the image and locates the relevant position in the editor. While it is armed, hovering the photograph rides a ghost point along the curve at the value under the cursor, so you know which point a patch belongs to before touching anything; on a hue row a neutral keeps the ghost where it last had a hue, and a click there drops its point at the ghost. A click drops a point on the curve at the value under the cursor and holds it there, and a drag up or down adjusts it. On a Depth cell that is how a subject is locked: hover to see the ghost at its depth, click to drop the point, then work the rest of the curve around it; on a Mask cell it reads the chosen mask's coverage under the cursor, and does nothing until a mask is chosen; on an Around cell it reads the surroundings exactly as the row does, over the Around reach dial's share of the frame; the Hue × Lum grid has no picker, since its cells are the control.

Increase Neutral guard when whites, grays, or shadows acquire a cast. Use Smoothing if adjacent hues or luminance ranges separate visibly.

![Recolor matrix](../assets/screenshots/section-recolor.png)

Hold the picker while the color or depth is read, then drag vertically to adjust the active cell. Releasing before the answer arrives still drops the point, without a drag. Changing the cell or its settings cancels a pending drag. Match uses the curves as they stand when the answer arrives, preserving edits made in the meantime; a pin never carries across a photograph, take, or preset change.

## Why a curve barely changes the picture

- **A Hue row on a muted photograph.** A dusk scene, haze or an overcast day is mostly near-gray, and the Neutral guard keeps near-grays out of the Hue rows: on one such photograph the default guard let a whole Hue to Lum curve at -2 darken the picture by about a seventh of a stop. When a Hue row's curve is moved far and the guard holds most of the photograph back, the line under the strip says how much it holds back, with **Lower to**: the highest setting that reaches most of it, as one undo step. The status line explains why as the warning appears. A photograph with almost no color says that instead: the Lum row, or Relight, works by brightness.
- **A Mask row with no mask chosen** does nothing until one is chosen under the curve.
- **A Depth row before the depth map exists** reads the scene as flat. Ask for depth with **Read depth**.

In the graph the depth arrives by wire, from the Depth Map node's depth output to this node's **depth** input, and asking for depth here adds the wire. With no wire the scene reads as flat, every depth the same, and a Develop section that is asking says NO DEPTH MAP. See [Depth Map](depth-map.md).
