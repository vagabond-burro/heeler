# Source nodes

Where a picture comes from, and the nodes that move its pixels around the frame. In the graph's **Add** menu and the menubar's **Node** menu they sit under **Source**, in two sections: **Source** and **Geometry**. Transform and Displacement Map wear the Utility stripe in the graph and are listed here, beside the other geometry: **Source > Geometry > Transform** and **Source > Geometry > Displacement Map**. Each node's **Menu** line gives its full path in the menus, category > section > node.

Sections: [Source](#source), [Geometry](#geometry).

## Source

### Image Source (`heeler.image_source`)

The photograph itself, decoded. Every graph has exactly one and it cannot be deleted or duplicated. The card names the file it decodes.

- **Menu:** Source > Source > Image Source.
- **Ports:** rgb out.
- **Highlights:** Clip cuts blown channels at white; Blend fills a blown channel from the ones that survived; Rebuild reconstructs blown areas and rolls their color off.
- **Demosaic:** Fast for culling, Standard for routine work, Fine (DHT) when judging detail or exporting.
- **As-shot white balance** and **camera matrix** are the decoder's own; switch them off to start from a neutral decode.

Use it as the start of every chain. Its settings are Adjustments' Source section.

### File (`heeler.file`)

Any image from disk: a second photograph, a texture, a logo. Choose the file in the inspector; the card shows its own thumbnail and name.

- **Menu:** Source > Source > File.
- **Ports:** rgb out, field out (mask). No input.
- **Path** is the file. No file, or a file that cannot be decoded, gives one transparent pixel rather than an error.
- **Layer** picks what the node reads of a multi-page TIFF or a layered OpenEXR: empty is the first picture, which is all any other format has; `page 2`, `page 3` and so on read that TIFF page as the picture, and an EXR layer group's name reads that group's RGB(A) channels. A name that is not a page or layer of the file shows the node as missing rather than guessing, and on any other format the field is ignored.

The mask diamond carries the read page's alpha: a TIFF saved with transparency (a cut-out logo, a rendered sprite) pipes its coverage straight into a mask input, Compare, Logic, Math or Remap. An opaque page feeds nothing, and the wire reads as empty. The Object layer in Adjustments lists the same alpha as a channel named **Alpha**, so it can be picked without wiring anything.

A layered TIFF from another editor keeps its layers in a private, undocumented block; Heeler reports that the block is there but cannot read the layer stack, so the composite pages above are what the node sees. The composite is the one page every writer and reader agrees on.

- **Space:** Scene-linear (the default) hands the decode on as it is, which is what a Merge or Blend Mode in the graph wants. Display (Finish layer) encodes it to the display space the Finish stack composites in, so a picture laid on a Finish layer looks like itself; a Finish [image layer](../../finish/image-layer.md) sets it.

Use it with Blend Mode or Merge to lay another picture over the photograph, and Transform to place it. A preset saved from a graph with a File node leaves the path behind, since it names a file on your machine.

### Catalog (`heeler.catalog`)

Another photograph from this catalog, as a source. The double-exposure node.

- **Menu:** Source > Source > Catalog.
- **Ports:** rgb out. No input.
- **Photo:** chosen in the inspector's browser, which opens in the folder on screen, walks up and into folders the catalog has scanned, and filters by name.
- **Mode:** As developed renders the other photo's own Output from the graph saved beside it; As shot decodes its file without edits.
- **Space:** as on the File node: Scene-linear for the graph, Display (Finish layer) for a Finish [image layer](../../finish/image-layer.md).

A photograph cannot contain its own developed self, and a chain of catalogs stops at two deep; both fall back to the decode. The card wears the catalog's rendered thumbnail.

### Color Checker (`heeler.color_checker`)

Camera calibration from a photographed reference chart: white balance, an exposure correction and a 3x3 matrix fitted to the chart's published values. Adjustments' Color Checker section, below Lens.

- **Menu:** Source > Source > Color Checker.
- **Ports:** rgb in, mask in, rgb out.
- **m00** to **m22** are the matrix, row-major; **Exposure** in stops; **Amount** fades the correction. The chart id, the placed quad and the fit report live on the node as text, written by the section's Calibrate, not by hand.

Sits after the warps and the Depth Map, before Color: it corrects the camera, so the grading downstream reads neutral light. At the identity matrix with no exposure, or Amount at zero, it is a bit-exact passthrough, alpha included.

## Geometry

### Crop & Rotate (`heeler.crop_rotate`)

Straighten and crop the frame. Adjustments' Geometry section, and the node the viewport's Crop and Straighten tools write to. Off and out of the graph until used.

- **Menu:** Source > Geometry > Crop & Rotate.
- **Ports:** rgb in, rgb out.
- **Straighten** rotates within the frame; **Aspect** widens (negative) or heightens; **Crop left/top/width/height** are fractions of the frame.

Pixels outside the crop stay in the source. The crop sits right after the source so nothing downstream reads across its edge.

### Lens Correction (`heeler.lens_correct`)

Distortion, color fringing and lens vignetting. Adjustments' Lens section.

- **Menu:** Source > Geometry > Lens Correction.
- **Ports:** rgb in, mask in, rgb out.
- **Distortion** barrel or pincushion; **Fringe R/C** and **Fringe B/Y** shift the color channels at the edges; **Lens vignetting** and its range undo the lens's corner falloff.
- **Model** chooses the distortion model (none, PTLens, Poly3, Poly5) with its coefficients.

Place it early: a warp applied after sharpening warps the sharpening.

### Perspective (`heeler.perspective`)

Keystone correction: stand leaning verticals up, square a facade.

- **Menu:** Source > Geometry > Perspective.
- **Ports:** rgb in, mask in, rgb out.
- **Vertical** and **Horizontal** tilt the frame; **Zoom** hides the revealed borders.

Use after Crop & Rotate and before anything that reads pixels.

### Grid Warp (`heeler.grid_warp`)

A grid of handles over the frame; drag them and the picture bends smoothly with them. Adjustments' [Grid Warp](../../adjustments/grid-warp.md) section, whose handles the viewport draws.

- **Menu:** Source > Geometry > Grid Warp.
- **Ports:** rgb in, rgb out.
- **Column** and **Row**, the grid's counts (4 by 3 to start on a landscape frame), the handles' moves, and **Edges**: **Stretch** carries the frame's edge pixels into a gap the warp opens, **Transparent** leaves it empty.

It sits right after Lens Correction, ahead of every mask and stroke, so what is painted afterwards lands where it was painted.

### Shape Warp (`heeler.shape_warp`)

Shapes placed over the frame, each moving, twisting or pinching the picture under it; a still shape holds what it covers. Adjustments' [Shape Warp](../../adjustments/shape-warp.md) section.

- **Menu:** Source > Geometry > Shape Warp.
- **Ports:** rgb in, rgb out.
- The list of **shapes**, each with its placement, feather and warp, and **Edges** as on Grid Warp.

It sits right after Grid Warp.

### Warp (`heeler.layer_warp`)

Grid Warp and Shape Warp on one node: the content of a Finish [Warp layer](../../finish/warp-layer.md), or an image layer's warp of its own picture. Finish makes and wires it inside the Finish group, where the layer's mask decides what is warped; edit it from the Finish tab.

- **Menu:** Source > Geometry > Warp.
- **Ports:** rgb in, rgb out.

### Transform (`heeler.transform`)

Move, scale and rotate about a pivot, in one node and one resample.

- **Menu:** Source > Geometry > Transform.
- **Ports:** rgb in, rgb out.
- **Move X/Y** as a percentage of the frame, **Size** as a percentage, **Rotate** in degrees, **Pivot X/Y** as a percentage of the frame.

The frame keeps its size. What leaves it is gone; what enters is transparent, so a transformed picture merges cleanly. Three nodes would resample three times; this one resamples once.

### Displacement Map (`heeler.displacement_map`)

Moves the picture's pixels by two fields: one says how far each pixel moves sideways, the other how far up or down. A graph-only node. Use a noise or gradient field for heat haze, ripples or a hand-made bend; use the picture's own luminance for a relief-like push.

- **Menu:** Source > Geometry > Displacement Map.
- **Ports:** rgb in, X field on the mask diamond, Y field on the alpha diamond (a mask pipe dropped nearer one diamond lands on it), rgb out. A field left unwired moves nothing on its axis. A Math node with nothing wired is a constant field (its **Constant**), the simplest way to try the node: 0.6 on X moves the whole picture a fifth of Strength to the right, 0.4 on Y the same distance up.
- **Strength**, in the photograph's pixels, 20 to start: a field reading 1 moves the picture this far right (X) or down (Y), 0 moves it this far left or up, and 0.5 leaves it where it is, with a straight line between.
- **Max displacement**, in the photograph's pixels, 50 to start: no pixel moves farther than this, whatever the fields say.
- **Edges**, Stretch to start, the same choice as Grid Warp and Shape Warp: where the picture moves away from the frame's edge, **Stretch** carries the edge pixels across the gap, and **Transparent** leaves the gap empty so a crop can take it off, or a layer underneath can show.

Each pixel is read from where the fields say it came from, blended between the four nearest pixels; a whole-pixel move is an exact shift. A read past the edge of the frame takes the edge's pixel with Stretch, and nothing with Transparent, the edge as crisp as the warps leave it. Alpha moves with the color. Fit, 1:1 and the export agree.

This node moves the picture, not the frame. Masks made from its output (a Range or Luminance mask wired after it) follow the moved picture, but masks read from ahead of it (brush strokes, a selection, a subject mask, the depth plane, anything wired from the photograph) stay where they were. Put the Displacement Map after the work those masks gate, or build the masks you need after it from its output.
