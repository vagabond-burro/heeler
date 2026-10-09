# Image layer

A picture brought into the Finish stack as a layer of its own, to move, size, turn and flip (with **Flip Horizontal** and **Flip Vertical** above the canvas) over the photograph: a logo, a texture, a second photograph for a double exposure, a sky, or a part of this photograph to move or reshape. It comes from one of three places:

- **From a file.** Any image Heeler opens: a JPEG, PNG, TIFF, HEIC, WebP, OpenEXR or RAW file. The file stays where it is and the layer reads it from there; nothing is copied into the catalog.
- **From the catalog.** Another photograph of this catalog, shown through its own edits, the way the [Catalog node](../graph/nodes/source.md) shows it.
- **From a selection.** The pixels inside the current selection, copied with **New Layer via Copy** (see [A copy of the selection](#a-copy-of-the-selection)).

## Adding one

- The **Image** button (a framed picture with a caret) in the Finish toolbar opens a menu: **From File…** opens the file dialog, **From Catalog…** opens the catalog's folder browser. While the stack is empty, **Image layer** in its list opens the same menu.
- The Layer menu has the same two: **Layer > New Finish Layer… > Image Layer… > From File…** and **From Catalog…**.
- **Layer > Layers from File…** reads the pages of a multi-page TIFF or the layer groups of a layered OpenEXR and makes one image layer per entry you check.
- **Layer > New Layer via Copy** (`Cmd+J` (`Ctrl+J` on Windows)), or **From Selection** in the **Image** button's menu, copies the pixels inside the selection (see [A copy of the selection](#a-copy-of-the-selection)).

The picture arrives at the top of the stack, Normal, 100%, named after the file or photograph, **centered and fitted inside the frame** with its own proportions kept: a wide picture spans the frame's width, a tall one its height. It is one undo step.

## A copy of the selection

To move or reshape part of the photograph (a subject to warp, a patch of background to move over something), select it with any selection tool, then press `Cmd+J` (`Ctrl+J` on Windows), choose **Layer > New Layer via Copy**, or **From Selection** under the Finish toolbar's **Image** button. The pixels inside the selection become an image layer directly above the active layer (on top when no layer is active), clear outside the selection and as soft at the edge as the selection is: a feathered or Polished selection gives a copy with that soft edge. It is placed exactly over the pixels it came from, so nothing changes until you move it.

- **What it copies.** The active layer's own picture when it is a Pixel or an Image layer (an Image layer's own warp included, as the stack shows it); otherwise, with an adjustment layer active or none, the photograph as developed, under every Finish layer.
- **What you can do with it.** It is an image layer like any other: the toolbar's **Transform** slot moves, sizes, turns, skews, pinches and warps it, **Warp** in its panel bends it with a grid or shapes, and it takes masks, effects, blend modes and opacity. To paint on the copy itself, clip a Pixel layer to it (see [Groups and clipping](groups-clipping.md)); to hide part of it, give it a mask.
- **Filling the place it came from.** The photograph under the copy is untouched, so a moved subject is still there where it was. Add a Pixel layer, drag it below the copy, and Clone and Heal on it read the photograph below to paint the old place out. The selection is kept after the copy, so the old place is still selected, and a drawn selection (a rectangle, an ellipse, a lasso) keeps those strokes inside it; **Select > Deselect** (`Cmd+D` (`Ctrl+D` on Windows)) frees the brush.
- **Resolution and crops.** The copy normally uses the photograph's own size, so it is as sharp at 1:1 and in the export as the photograph, and on a cropped or turned photograph it lands on the pixels the selection covered. Unlike a picture from a file, it stays on the part of the scene it came from when you crop again, turning with the crop.
- **Where the pixels live.** Heeler keeps the copied pixels in its own data folder, beside the other things your edits point at, and the layer's panel says "Copied from a selection" where a file's name would be. Recovery bundles carry them while **Preferences > Backup > Keep baked pictures in backups** is on (the default), and the status line says how much each copy adds to a bundle. **Choose** puts a picture from a file in its place, as on any image layer.

If full-size decoding fails or there is not enough memory for the full-size render, Heeler uses preview-sized pixels and records the fallback in the Console. That copy can be softer at 1:1 and in the export. Undo it and retry after resolving the decode or memory problem if you need full resolution.

It is one undo step. In the graph it is a File node in the Finish group like any image layer.

## Placing it

The picture's name and its transform are the layer's settings, which open and close like an adjustment's (see [Settings that open and close](README.md#settings-that-open-and-close)); a missing file is said in the row either way. Open, the row shows the picture's name and, below it, the transform:

- **X %** and **Y %**: where the picture's center is, in percent of the frame. 50 and 50 is the middle.
- **W %** and **H %**: its width and height, in percent of the size it arrived at (fitted inside the frame). Type 50 in W to halve its width.
- **Angle**: how far it is turned about its center, in degrees clockwise.
- **Keep Proportions** (a chain, whole when on, broken when off): when on, W and H change together and the corner handles keep the picture's shape.

Below the fields is a row of picture buttons. Point at one and the status line says its name and what it does:

| Button | Picture | Does |
| --- | --- | --- |
| **Warp** | a grid whose lines bow | Gives the picture a warp of its own, a grid or shapes that bend the picture itself, and opens it; see [Warping the picture](#warping-the-picture). Once it has one, the same button is **Edit warp**, and **Remove Warp** (the grid struck through) sits beside it. |
| **Reset** | the arrow going back round | Puts the picture back square, centered and fitted, as it arrived. |

The handles on the canvas are the Finish toolbar's **Transform** slot (below), and **Flip Horizontal** and **Flip Vertical** sit above the canvas (see [Flipping a layer](README.md#flipping-a-layer)): a picture mirrors in place, turned as it is. The panel holds what has no other seat.

Each typed number is one undo step. The same fields sit on the layer's Blend node in the graph Inspector.

### On the canvas

With the **Transform** tool (the Finish toolbar's Transform slot, in its Transform mode), the layer's outline has handles:

| Drag | Does |
| --- | --- |
| Inside the outline | Moves the picture. It snaps to the frame's center and edges when it comes within a few pixels, and a line shows the snap. Hold `Cmd` (`Ctrl` on Windows) to move without snapping. |
| A corner | Sizes it from the opposite corner, width and height each following the pointer. |
| An edge | Sizes that side only, from the opposite edge. |
| Just outside a corner, or the round handle above the top edge | Turns it about its center. |

- `Shift` keeps the picture's proportions while you size it (with Keep Proportions on, `Shift` frees them for that drag), and snaps a turn to 15-degree steps.
- `Option` (`Alt` on Windows) sizes from the center instead of the opposite corner or edge.
- Dragging a corner or edge through the opposite side mirrors the picture, as every free transform does.
- `Enter` keeps what you did and puts the tool down; `Esc` puts the picture back where it was when you picked the tool up. Each drag is one undo step.

While the tool is up, the status line names these keys with your computer's names for them.

### Skew, perspective and warp

The Transform slot's popup (hold the toolbar button, or right-click it) puts the handles in a mode with no key held, for a trackpad:

| Mode | Picture | On a corner | On an edge |
| --- | --- | --- | --- |
| **Transform** | a box with its corners marked | Sizes, as above. | Sizes, as above. |
| **Skew** | a square slid into a parallelogram | Slides its edge along itself, whichever of its two edges you drag along, so the picture stays a parallelogram. | Slides along itself, so the sides lean. |
| **Perspective** | a square pinched into a trapezoid | Slides along one edge while the corner at that edge's other end slides the other way, so the picture leans away evenly. | Slides along itself, as in Skew. |
| **Warp** | a box with one corner pulled out | Moves on its own, anywhere (a distort). | No edge handles: Warp is corners only. |

Moving and turning work in Transform, Skew and Perspective. Skew and Perspective keep every straight line straight, as Warp does; none of them bends the picture (to bend it, see [Warping the picture](#warping-the-picture)). The slot remembers its mode, so the next tap of the button (or `T`) arms the same one.

In any mode you can also hold a key while you drag a corner or an edge:

| Keys (Mac / Windows) | On a corner | On an edge |
| --- | --- | --- |
| `Cmd` / `Ctrl` | **Distort:** the corner moves on its own, anywhere. | The edge moves freely, both its corners with it. |
| `Cmd+Shift` / `Ctrl+Shift` | **Skew:** the corner's edge slides along itself, whichever of its two edges you are dragging along. | **Skew:** the edge slides along itself, so the sides lean. |
| `Cmd+Option+Shift` / `Ctrl+Alt+Shift` | **Perspective:** the corner slides along one edge and the corner at that edge's other end slides the other way, so the picture leans away evenly. | Skew, as above. |

Adding `Option` (`Alt` on Windows) to a distort or skew moves the opposite corner or edge the other way, so the change is even about the center. `Cmd` (`Ctrl` on Windows) on the inside of the outline still moves without snapping: the inside and the handles are different places to press.

In Skew, `Option+Shift` (`Alt+Shift` on Windows) on a corner is the perspective pinch.

All of these write the same four corners the Warp mode does, so the canvas, the render at Fit and at 1:1, and the export put the picture on the same four points.

A drag that would fold the picture over itself (a corner pushed in past the line of its neighbors, or two edges crossing) or turn it inside out is refused: the corners stay at the last good shape until the pointer comes back, and the status line says why. Use **Flip Horizontal** or **Flip Vertical** above the canvas to mirror it.

After a skew, **W**, **H** and **Angle** read from the picture's top and left edges and the panel says it is skewed. After a distort or a perspective pinch there is no one width, height or angle, so those three fields say "distorted"; **X** and **Y** still show where its center is. Typing a number into a "distorted" field sizes or turns the shape as it stands. **Reset** makes it a plain fitted rectangle again.

The handles work at any zoom, on any display. A picture can be moved or sized past the frame's edge; what is outside the frame is not in the photograph.

## Warping the picture

The Transform slot's modes move the picture's four corners. To bend what is inside them, give the picture a warp of its own: the **Warp** button (a grid whose lines bow) in the layer's panel. It adds the warp and opens it, with its handles on the canvas, drawn on the picture where it stands. Under the transform, the panel then shows, in order:

- **Type**: **Grid** or **Shapes**, the one the picture's warp applies, Grid to start. Switching keeps the other type's grid or shapes, not applied, so switching back brings them back; each switch is one undo step. On Shapes, **Add shape** sits on the same row, to the right of the menu.
- **Room**: how far past its own edges the picture can be pulled, in percent of each side, 25 to start. A logo cropped tight to its edges needs room for an enlarged part to grow into; more room costs memory on a large picture.
- The chosen type's section: [Grid Warp](../adjustments/grid-warp.md) or [Shape Warp](../adjustments/shape-warp.md), the same controls as in Adjustments and on a [Warp layer](warp-layer.md).

Once the picture has a warp, the button reads **Edit warp** and puts its handles on the canvas and takes them off again. Unlike a Warp layer, opening an image layer's settings does not put its warp's handles up: the settings are the picture and its transform first. The warp's Type, Room and controls show with the layer's open settings, under the transform, whether or not its handles are up.

The warp belongs to the picture, not to the frame. The grid and the shapes are measured on the picture itself, so they move, size, turn, skew and pinch with it: move the layer and the enlarged part of the logo goes with it. A pull can carry part of the picture past its own rectangle into the room around it, and the picture's transparency comes along, so a logo's outline bends with it. The layer's mask still decides where any of it shows, and the photograph below is never touched.

`Enter` keeps what you did and closes the warp, and `Esc` puts it back the way it was when you opened it; each drag is one undo step. **Remove Warp** (beside Edit warp, the grid struck through) takes the warp away and the picture goes back to its own shape, the transform untouched. Duplicate, Copy and Paste Edits, takes and saving carry the warp with the layer; a crop leaves it alone, as it leaves the picture's proportions alone.

In Shapes mode, drag inside the ring to move the picture, outside it to twist, or on the ring to pinch. The ring follows the moved picture. Hold **Shift** to lock a move to an axis or step a twist by 15 degrees; **Option** (**Alt** on Windows) on the ring adjusts its axes separately. What you push covers the picture ahead of it. A strong pull can squeeze the feather into a hard-looking edge; widen the feather or pull less. In Grid mode, **Shift** locks a drag to one axis and the arrow keys nudge picked handles by one photograph pixel (**Shift+arrow** by ten).

To warp an image layer together with the photograph and every other layer below it, use a [Warp layer](warp-layer.md) above it instead.

## What you see is what exports

The picture is placed from its own pixels in one step, at whatever size the view needs: at Fit it is drawn at the view's size, at 1:1 and in the export from the file's full resolution, so a logo is as sharp in the export as the file is. Its colors come through the same color management as the photograph, and in the Finish stack's display space, so a picture looks like itself. A picture's own transparency (a PNG, a TIFF or an OpenEXR with alpha) is kept: the photograph shows through where the picture is clear.

Opacity, blend modes, [masks](masks-selections.md) (painted and from a selection), [layer effects](layer-effects.md), groups, clipping, reordering, duplicating, renaming and the **Export** checkbox behave as on any other layer. Deleting an image layer deletes no file.

## After a crop, or on another photograph

A placed picture keeps its own proportions when the frame changes shape: a crop to another ratio, the crop turned between landscape and portrait, or **Paste Edits** or a linked photograph bringing the layer onto a photograph of another shape. A square logo stays square. Its center stays at the same place in the frame (in percent, so a logo in the lower right corner stays in the lower right corner), and its size stays the same share of the frame's short side, so a crop that only trims the long side leaves the picture exactly the size it was. Its angle and any warp are kept. **X**, **Y**, **W**, **H** and **Angle** read the same numbers after the crop as before, and undoing the crop puts everything back as it was.

A picture that spanned the frame's long side can reach past the edges of a narrower frame after a crop; what is outside the frame is not in the photograph, so size it again to bring it back inside.

The other Finish layers are not placed pictures and follow what they are made of. Painted strokes, Clone and Heal and Dodge & Burn are painted on the photograph and measured as a share of the frame; Fill and Gradient layers and the adjustment layers fill the whole frame, whatever its shape. A Transform on one of those layers travels with its content the same way.

Image layers made before this behavior (in 2026.4 test builds) keep reading their corners as a share of the frame until they are moved, sized or turned once, which records the frame's shape on the layer.

## When the picture is missing

A file that has been moved, renamed or is on a drive that is not connected leaves the layer empty (the photograph shows through) and the layer says so in its row, with the path where the file was: for example, "The file is missing. It was at /Volumes/Archive/logo.png". **Relink** (a folder and a magnifier, beside the file's name) opens the file dialog; pick the file where it is now and the layer comes back where it was. While the file is there, the same button is **Choose** (a folder with an arrow going in) and puts a different picture in the same place: a picture of another shape keeps the position, size and angle and its own proportions.

A photograph from the catalog that has been removed from the catalog, or whose file is missing, says that in the same place.

## A photograph from the catalog follows its edits

The layer shows the other photograph as it is developed now. Edit that photograph, come back, and the layer shows the new edits on its next render. The other photograph is rendered through its own saved edits, its own layers included. A photograph cannot contain itself: picked on itself, the layer shows its file without edits, and a chain of photographs stops two deep the same way.

## In the graph

An image layer is two nodes inside the Finish group: a [File node or a Catalog node](../graph/nodes/source.md) with **Space** set to Display (Finish layer), feeding a Blend node whose **Fit** is **Placed**. The Blend carries the transform, and its Inspector shows the same fields as the layer's panel. A picture with a warp of its own has a third node between the two, a **Warp** node, whose Inspector shows the same **Edit warp** button and, open, the same Type, Room and controls as the layer's panel. The File node holds the path as it was chosen, the full path on this computer.

A layered TIFF from another editor carries its layers in a private block Heeler cannot read; **Layers from File…** offers the composite page and says why. See the File node page for the whole story.
