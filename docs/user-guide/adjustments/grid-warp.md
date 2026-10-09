# Grid Warp

Grid Warp draws a grid of handles over the photograph. Drag the handles and the picture bends smoothly with them. It is a geometry adjustment like Straighten: it reshapes the frame before every mask, stroke and layer, so anything you paint afterwards lands where you painted it. The edit is non-destructive and lives on one Grid Warp node in the chain's geometry, right after Lens. The section sits directly below Geometry.

Arming the tool does not switch the section on; moving a handle does, the way moving any control switches its section on, and the first drag on a photograph builds the node switched on.

## The grid

A photograph starts with four columns by three rows across a landscape frame, three by four down a portrait one. The intersections are the handles.

- **Column** and **Row** are numbers you drag: drag sideways to change them a step at a time, or click without dragging to type one. The warp is kept: the new handles take the field's value where they sit, so a denser grid adds control without starting over.
- The **link** button beside Column ties the two together: with the link on, a change to one is the same change to the other.
- **Alt-click** on open grid adds a column and a row through that point, which is how you put handles exactly where they are needed. **Alt-click a line** takes it out. The frame's own edges stay.

## Picking handles

- Click a handle to pick it; Shift-click adds one or takes one out of the pick. Shift-click on a picked handle takes it out only if you let go without dragging; drag instead and the whole pick moves, locked to one axis (see below).
- Drag on the grid to marquee several. Shift with the marquee adds to the pick.
- **All**, **None**, **Grow** and **Shrink** in the section: Grow takes in every neighbor along the grid, Shrink drops the pick's rim, the frame's edge included.

## Moving, twisting and pinching

- Drag a picked handle to move the whole pick.
- Hold **Shift** while dragging and the move is locked to one axis: across or down, whichever the pointer has gone further along since you pressed. Press or let go of Shift at any point in the drag and the lock comes on or off at once. The axes are the picture's own, so the lock holds a handle on its row or column even with the view turned (on an image layer's own warp, the layer picture's axes).
- The **arrow keys** nudge the pick by one pixel of the photograph, **Shift+arrow** by ten, whatever the zoom, with the Influence falloff as a drag of that size would have. With the view turned, an arrow moves along the picture's axis nearest its direction on screen. A run of presses, held keys included, is one undo step, ending when you let go of the last arrow. While the tool is up the arrows belong to the grid and do not step through photos; a focused slider or text field keeps its own arrows, and a click on the grid takes them back.
- **Twist** is a wheel in the section: drag round it and the pick turns about its center, as far round as you like, with the angle read out below it. Shift snaps to fifteen degrees. With Influence above zero, twisting a single picked handle twists the picture around it.
- **Pinch** is a pad in the section: drag from its center and the pick pulls out or pinches in about its center. Right makes it wider, left narrower, down taller, up shorter, and a diagonal does both. The further you pull, the more; there is no limit. Shift keeps it uniform. The readout below shows the width and height as percentages.

The two sit side by side under Edges and grow with the panel.

Both spring back to rest on release, so every drag starts fresh, and each drag is one undo step. They work on whatever is picked, and sit idle until something is.

The picture redraws under the pointer as you drag, from the canvas or from the section. On release the engine renders the warp properly, at full quality, and the 1:1 view stays sharp.

## Influence

**Influence** is how far a drag carries past the picked handles, in grid steps. At zero only the pick moves. At one the neighboring handles come along at half strength, at two the next ring out comes too, and so on, fading with distance. It is a property of the drag: set it, then drag, and that drag uses it.

**Heat** shows the influence before you move anything, with three icon buttons:

- **Luma** (the half-filled circle): picked handles white, fading through gray to black past the influence.
- **Chroma** (the red and blue circle): picked handles red, cooling to blue past the influence.
- **Off** (the struck circle): picked handles white, the rest gray, no falloff shown.

The heat is on the handles only. The photograph between them stays as it is.

## The lines' color

The grid lines take the opposite of the photograph: the complementary hue of its average color, dark on a light picture and light on a dark one, and plain gray on a gray picture. That is the automatic choice, and it is what you get on every photograph until you say otherwise.

The **Hue** and **Luma** sliders under **Lines** take over from it, and the swatch beside them shows the color in use. **Auto** hands the choice back to the photograph.

The choice is one for every tool that draws lines over the photograph: Shape Warp's rings and the Radial layer's gizmo take the same color, and their Lines rows set the same thing.

**Thickness** is the same shared setting the other line tools carry: Preferences (Interface, Shape outline thickness) sets it for every photograph, the number here sets it for this photograph alone, and **Preference** hands it back. It is a view setting, kept with the photograph: setting it marks nothing edited and is not an undo step.

## Edges

Where the picture pulls away from the frame, **Stretch** carries the border pixels in to cover the gap, which is what a subtle reshape wants. **Transparent** leaves the gap empty so a crop can take it off, or a Finish layer underneath can show.

## Reset

The section's Reset puts every handle back to rest. The grid keeps its density.

## Keys

- **Shift+G** arms and puts away the tool.
- **Shift** while dragging a handle locks the move to one axis.
- **Arrow keys** nudge the picked handles one photograph pixel; **Shift+arrow** ten.
- The status line lists these keys while the tool is up.
- **Enter** keeps the warp and puts the tool away.
- **Escape** puts the mesh back the way it was when the tool was armed, and takes the node out again if the tool built it.

## Notes

- Copy Edits and presets leave the mesh behind: it describes one photograph's frame and content.
- Changing the photograph, the pick, or the tool during a drag cancels its uncommitted preview, and closing the section cancels a wheel or pad drag. If the window loses focus mid-drag, the drag ends where it stands.
- Re-cropping after warping keeps the warp on the content it bends, through any change of rectangle, ratio or angle. The grid itself belongs to the frame it was drawn on: pick up Grid Warp again after a re-crop and its handles are laid out on the new frame, carrying the same warp, so the first handle you move redraws it on the new frame's grid (between handles the curve can change a little, as when inserting a line).
- The main Graph inspector shows the section controls for the tool's node. A popped-out inspector shows the grid counts and wiring guide.

- Very strong pulls can fold the grid onto itself. A handle dragged across its neighbor covers what it is dragged over, as in Liquify; the fold's edge can show a seam or an abrupt change. Reduce the pull to keep the grid from crossing itself.
- Inserting a line samples the existing warp onto a new grid. Between handles the curve can change, especially with uneven spacing. Removing that same new line restores the old handle values.
