# Shape Warp

Shape Warp places shapes over the photograph and moves the picture under each one. A shape is one the Radial layer draws, ellipse, rectangle, triangle, crescent, trapeze, cross or semicircle, with a center, a radius, a feather, an aspect and a rotation. Inside the shape the picture follows your drag in full; across the feather the pull fades to nothing; outside, nothing moves. It is a geometry adjustment like Grid Warp: it reshapes the frame before every mask, stroke and layer, so anything you paint afterwards lands where you painted it. The edit is non-destructive and lives on one Shape Warp node in the chain's geometry, right after Grid Warp. The section sits directly below Grid Warp.

The section ships collapsed and switched off. Adding a shape builds the node switched on. Arming the tool on its own switches nothing on; on a section that has been switched off, moving a shape's pixels switches it back on, the way moving any control switches its section on.

## Shapes

**Add shape**, beside **Place shapes** at the top of the section, puts a new shape in the middle of the frame, picks it and arms the tool in Position mode. On a [Warp layer](../finish/warp-layer.md) or an image layer's own warp it sits on the **Type** row instead, to the right of the menu. The list under it holds every shape on the photograph:

- Click a row to pick that shape. The picked shape is the one the modes, Feather, Amount, Twist, Pinch and Reset warp act on.
- The **dot** at the row's left switches a shape off and on: filled when the shape is on, hollow when it is off. A shape that is off keeps its placement and its warp and does nothing to the picture; it draws dashed on the canvas.
- The **name** is the shape's outline and its place in the list, Ellipse 1, Triangle 2, until you give it one of your own. Because the name follows the outline, changing an ellipse to a triangle changes what the row says. The **pencil** names the shape; so does a double-click. Enter keeps the name, Escape leaves it, and an empty name hands the shape back to its automatic one.
- The **outline** dropdown gives the shape any outline the Radial layer can take. Three of them have a knob of their own, shown under Feather while such a shape is picked: **Bite** for the crescent, **Taper** for the trapeze, and **Arm width** for the cross.
- The **x** takes the shape out of the list. Taking out the picked shape picks the last one left.

## Position and Warp

The two **Mode** chips say what a drag on the canvas does to the picked shape.

- **Position** draws the Radial layer's own gizmo on the picked shape: drag the center to move it, the rim to resize it, the inner ring to set the feather, the side handles to stretch it, and the rotation handle to turn it. Placing a shape moves nothing in the picture.
- **Warp** moves, twists and pinches the picture. Each shape's ring is drawn where its warp put the picture, so after a drag the outline sits on what you moved, and the picked shape's placement shows as a faint dashed ghost. Where you press says what the drag does, and the cursor says it before you press:
  - **Inside the shape** (the four-way move cursor): the pixels under it come along, the center in full and the feather fading. What you push covers what is ahead of it, as in Liquify: drag a head sideways and it arrives whole over the background it was pushed onto, its feather squeezed into a band in front of it. Dragging past the frame is fine: the pull is measured from where you started. A second drag from the moved ring carries on the same warp. `Shift` while dragging locks the move to one axis.
  - **Outside the shape** (the rotate cursor): the picture inside the picked shape twists about the shape's middle by the angle you sweep, as far round as you like. `Shift` steps the twist by fifteen degrees, as on the Twist wheel.
  - **On the ring's edge** (a resize arrow, within a few screen pixels of the solid ring at any zoom): the picture pinches in or pulls out by how far you take the edge from the middle, both axes together, so dragging the edge half as far out again makes it 150 percent. `Option` (`Alt` on Windows) pulls each of the shape's own axes on its own, the Pinch pad's two axes: grab the side to change the width, the top to change the height. `Shift` keeps it uniform.

  The section's Twist wheel and Pinch pad show a canvas twist or pinch while you drag, and spring back on release, as they do for their own drags. The status line names the gestures and their keys while the tool is in Warp mode. Each drag is one undo step, and a press let go without moving changes nothing.

A click inside another shape picks it, in either mode.

## Feather

**Feather** is how softly the picked shape's pull fades at its edge, in percent: 0 is a hard edge, 100 fades all the way from the center. Drag the number sideways to change it a step at a time, or click without dragging to type one. The gizmo's inner dashed ring is the same feather; drag that ring in Position mode to set it by eye.

## Twist and Pinch

With a shape picked, **Twist** and **Pinch** in the section work on the picture under it, about the shape's center. The same two work on the canvas in Warp mode: drag outside the shape to twist, grab its ring to pinch (see [Position and Warp](#position-and-warp)).

- **Twist** is a wheel: drag round it and the picture turns inside the shape, as far round as you like, with the angle read out below it. Shift snaps to fifteen degrees.
- **Pinch** is a pad: drag from its center and the picture pulls out or pinches in. Right makes it wider, left narrower, down taller, up shorter, and a diagonal does both. The pull follows the shape's own axes, so a turned shape pinches along its turn. Shift keeps it uniform.

Both spring back to rest on release, so every drag starts fresh, and each drag is one undo step. They add to what the shape already holds.

## Amount

**Amount** is how much of the picked shape's warp applies, from 0 to 100 percent. Ease a warp back without redoing it, or take it to nothing while keeping the drag for later.

**Reset warp** puts the picked shape's move, twist and pinch back to rest. Its placement stays.

## Holding

**Hold this area** turns the picked shape into a protector. The picture under it stays where it is, however hard another shape pulls, and its feather eases that grip at its edge rather than ending it at a wall. Overlapping holders hold no harder than one.

A holding shape does not warp, so its Warp mode, Amount, Reset warp, Twist and Pinch are put away while it holds. Click the chip again and it warps like any other shape. Holding is something you ask a shape to do: a shape you simply have not dragged protects nothing.

## How shapes combine

Only shapes that move something take part. A shape you have placed but not dragged, one with Amount at zero, and one switched off all mean the same thing here, which is nothing: none of them changes what a shape beside it does.

Where two moving shapes overlap they share the pull. Each pixel takes the average of the shapes reaching it, weighted by how strongly each reaches it, so two shapes pulling the same way at full strength pull that way once, not twice. Where their edges overlap at less than full strength, both are still fading in, and together they pull further than either alone.

The picture redraws under the pointer as you drag, from the canvas or from the section. On release the engine renders the warp properly, at full quality, and the 1:1 view stays sharp.

## Edges

Where the picture pulls away from the frame, **Stretch** carries the border pixels in to cover the gap, which is what a subtle reshape wants. **Transparent** leaves the gap empty so a crop can take it off, or a Finish layer underneath can show.

## The lines' color

The rings take the opposite of the photograph: the complementary hue of its average color, dark on a light picture and light on a dark one. The **Hue** and **Luma** sliders under **Lines** take over from it, and **Auto** hands the choice back. It is the same setting Grid Warp and the Radial layer use, so a color chosen here is theirs too. In Warp mode the picked shape is drawn in the accent color. In Position mode its placement gizmo uses the shared line color.

**Thickness** is how heavy the outlines draw, in pixels. Preferences (Interface, Shape outline thickness) sets it for every photograph, the Radial and Linear layers' gizmos included, and ships at 2. The number here sets it for this photograph alone, every shape at once, and is kept with the photograph; **Preference** hands it back. It is a view setting like the preference, not an edit: setting it marks nothing edited and is not an undo step.

## Reset

The section's Reset puts every shape's warp back to rest. The shapes stay where they are placed, on or off as they were.

## Keys

- **Shift+W** arms and puts away the tool.
- **Enter** keeps the shapes and puts the tool away.
- **Escape** puts the shapes back the way they were when the tool was armed, and takes the node out again if the tool built it.

## Notes

- Shape Warp runs after Grid Warp. A shape placed on a grid-warped photograph is measured against the warped frame.
- Copy Edits and presets leave the shapes behind: they describe one photograph's frame and content.
- Re-cropping after warping keeps each shape on the content it pulls: its place, size, turn and move follow the photograph through any change of rectangle, ratio or angle.
- The main Graph inspector shows the section controls for the tool's node. A popped-out inspector shows the wiring guide.
- A drag folds the picture where it carries the shape over what lies ahead, and there the part carried furthest shows: the shape's middle, then its squeezed feather, then the background. Very strong pulls with a narrow feather squeeze the feather into a thin band that reads as a hard edge; widen the feather, or ease the pull or Amount, to soften it.
- The Feather, Amount, shape-specific value and Thickness controls are sliders with a number you can type. Thickness's number also drags: press on it and move sideways to change it a pixel at a time. A drag on Feather, Amount or the shape-specific value is one undo step; Thickness, a view setting, is not on the undo history. A control that needs a picked shape stays disabled until you pick one.
- Changing the photograph, the picked shape, or the tool during a warp drag cancels its uncommitted preview, and closing the section cancels a wheel or pad drag. A placement edit already made stays on the shape it was made on, and a rename in progress is abandoned if you change photographs before keeping it.
