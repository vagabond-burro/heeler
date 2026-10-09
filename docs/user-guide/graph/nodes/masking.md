# Masking nodes

Selections by shape, paint and model, selections by tone and color, and the tools that shape a mask once it exists. Every node here except Tone Mask gives a field, the purple diamond on the right, and a field lands on any node's mask port or on the inputs of Compare, Logic, Math, Remap, Conditional and Channel Join. In the add menus they sit under **Masking**, in three sections: **Masks**, **Range Masks** and **Mask Tools**. Tone Mask wears the Utility stripe and is listed here with the other range masks (**Masking > Range Masks > Tone Mask**); Measure, Compare and Logic, the logic family, are **Utility > Math & Logic > Measure**, **Utility > Math & Logic > Compare** and **Utility > Math & Logic > Logic**. Each node's **Menu** line gives its full path in the menus, category > section > node.

Sections: [Masks](#masks), [Range Masks](#range-masks), [Mask Tools](#mask-tools).

## Masks

### Radial Mask (`heeler.radial_mask`)

An ellipse, feathered.

- **Menu:** Masking > Masks > Radial Mask.
- **Ports:** rgb in, field out.
- **Center**, **Radius**, **Feather**, **Aspect**, **Rotation**, an optional **Shape** with its amount, **Invert**.

### Linear Mask (`heeler.linear_mask`)

A gradient across the frame.

- **Menu:** Masking > Masks > Linear Mask.
- **Ports:** rgb in, field out.
- **Angle**, **Position**, **Span**, **Invert**.

### Brush Mask (`heeler.brush_mask`)

Painted by hand with the mask brush.

- **Menu:** Masking > Masks > Brush Mask.
- **Ports:** rgb in, field out.
- **Strokes**, **Invert**. Reset leaves the strokes alone.

### Selection Mask (`heeler.selection_mask`)

Outlines and color picks kept as editable geometry: the Select tool's document selection, or a layer's converted mask.

- **Menu:** Masking > Masks > Selection Mask.
- **Ports:** rgb in, field out.
- **Regions** and **Strokes**, **Feather**, **Grow**, **Smooth**, **Border width**, **Ramp**, **Invert**, **Antialias**, and a baked matte when a polish pass has been applied.

### Smart Mask (`heeler.smart_mask`)

A model's selection as a mask: the subject, the sky, or what you click. Computed on demand by a model on this computer and cached beside the photo.

- **Menu:** Masking > Masks > Smart Mask.
- **Ports:** rgb in, field out.
- **Mode** Click, Subject or Sky; **Prompts** are the clicks; **Threshold**, **Expand**, **Feather**, **Invert mask**, and the **Depth mask** block.

In the Inspector the node wears the controls a Smart layer has in Develop, aimed at this node:

- **Click**, **Subject** and **Sky** buttons choose the mode. Subject and Sky run the model as soon as you press them, the same as in Develop. Beside them are **Refine**, **Remove**, **To Mask** and **Clear**.
- A line under the buttons says what the mask holds. A Subject or Sky the model has not run on yet (a graph from another computer, or one the assistant built) says **Not detected yet** and offers **Detect**, which runs the model for this node. Once it has run, the line says **Detected** and the button reads **Detect again**.
- In Click mode, **Click to select** arms the click tool for this node: a click on the photograph adds to the mask, an Alt-click (Option on a Mac) takes away. Clicks saved on another computer show **Clicks saved, mask not computed on this machine** with **Recompute**.
- **Threshold**, **Expand** and **Feather** shape the mask, **Invert mask** flips it, and the **Depth mask** block multiplies it by the depth map, as on a Develop layer.

Without the Smart selection model, the mask stays empty. The Inspector says **Empty until the Smart selection model is installed, in Preferences > Models**, and **Get the model** opens that page. The card says **Model not installed: mask empty** under its picture. A card whose Subject or Sky has not been detected says **Not detected yet: Detect in the Inspector**, and a Click mask with no clicks says **No clicks yet: mask empty**.

### Object Mask (`heeler.matte_mask`)

The mask a renderer wrote into the photograph's own OpenEXR: objects or materials named in a Cryptomatte layer, or one plain matte channel. A TIFF with transparency offers its first page's alpha the same way, listed as the channel **Alpha**, and an OpenEXR's own alpha is offered the same way, so a photograph exported from Heeler with a selection as its alpha gets that selection back as a mask. Exact to the pixel, with the render's own anti-aliased edge. A photograph whose file names nothing renders it empty.

The Object layer button and the Layer menu's Object item appear for every OpenEXR, and for any other photograph whose file carries a matte channel (a TIFF's alpha), and then first in the row; an EXR that names no objects says so in the panel. Its panel is a list: a filter field above, up to eight names showing at once, the rest by scrolling, a check on every name in the mask. The Object, Material and Channel sources sit above the list when the file has more than one.

A multi-part OpenEXR lists every part's channels, named by part: `depth_left.Z`, `crypto.CryptoObject`. A luminance/chroma file (subsampled channels) is refused by name.

- **Menu:** Masking > Masks > Object Mask.
- **Ports:** rgb in, field out.
- **Layer** the Cryptomatte layer the names belong to (empty for a plain channel); **Names** the objects chosen, or the channel; **Feather**, **Invert**.

## Range Masks

### Luminance Mask (`heeler.luminance_range_mask`)

Select a band of brightness, in scene-linear light.

- **Menu:** Masking > Range Masks > Luminance Mask.
- **Ports:** rgb in, field out.
- **Low** and **High** bound the band in 0 to 1, starting at 0 and 1; **Feather** (0.1 to start) rolls the mask off below Low and above High; **Invert** takes every tone outside the band instead.

In the Inspector the node wears the Levels control from **Adjustments > Levels**: the luma histogram of the picture arriving at the node's input, not the finished picture, with **Low** and **High** as the two handles along its foot. The two handles hanging from the top edge mark where each edge's roll-off ends, one Feather shared by both edges: drag either to soften or sharpen the band. The part of the histogram the mask takes is lit, and the lit part swaps sides when **Invert** is on. Under the plot, the Low, High and Feather sliders set the same values (each with a typed field), and each drag is one undo step.

The histogram's axis is the mask's own scene-linear scale, so a handle sits over exactly the tones it selects. Scene-linear values run darker than the screen's: middle gray sits near 0.18, and 0.25 is already a bright tone, so most of a photograph's histogram gathers at the left. It can select an HDR highlight above 1, which the plot counts in its last column.

### Color Range Mask (`heeler.color_range_mask`)

Select a band of color around a picked color.

- **Menu:** Masking > Range Masks > Color Range Mask.
- **Ports:** rgb in, field out.
- **Color**, **Range** as a distance around it, **Falloff**, **Invert**.

### Hue Range Mask (`heeler.hue_range_mask`)

Select a band of hue, neutrals excluded. The selection half of a Color Set.

- **Menu:** Masking > Range Masks > Hue Range Mask.
- **Ports:** rgb in, field out.
- **Band center** in degrees, **Range**, **Falloff**, **Invert**.

### Range Mask (`heeler.range_mask`)

Select by luma, saturation and hue together.

- **Menu:** Masking > Range Masks > Range Mask.
- **Ports:** rgb in, field out.
- **Luma** low and high, **Saturation** low and high, **Hue** center and width, **Softness**, **Invert**. Defaults select everything.

### Chroma Key (`heeler.chroma_key`)

A basic keyer: the matte of a green or blue screen as a mask, black where the picture is the key color and white on the subject. A graph-only node.

- **Menu:** Masking > Range Masks > Chroma Key.
- **Ports:** rgb in, field out.
- **Key r**, **Key g**, **Key b**: the screen's color as it reads on screen, 0 to 1 a channel (multiply an 8-bit value by 1/255). Chroma key green, 0, 0.694 and 0.251, to start; for a blue screen try 0.1, 0.3 and 0.9.
- **Tolerance**, 0.05 to start: how far from the key a color may be and still key out completely. **Softness**, 0.1 to start: the width of the fade from keyed out to kept past that (0 is a hard edge).

Colors are compared by their hue and colorfulness alone, with brightness left out (the comparison is in OkLab, a space where equal steps look equal), so the screen in shadow or under a hot spot still reads as the screen, and a part of the screen more colorful than the key color keys out as cleanly. Grays, black and white are far from any colorful key and stay. To take the screen's green off the subject's edges, follow the picture with **Chroma Key (Despill)** (**Color > Color > Chroma Key (Despill)**); to make the matte the picture's transparency, wire it into **Alpha Association** set to Replace.

### Tone Mask (`heeler.tone_mask`)

Shadows, midtones, highlights, or the midtone bell, as a picture. A helper for the recipes.

- **Menu:** Masking > Range Masks > Tone Mask.
- **Ports:** rgb in, rgb out.

## Mask Tools

### Invert Mask (`heeler.invert_mask`)

One minus the mask: the Outside half of a pair.

- **Menu:** Masking > Mask Tools > Invert Mask.
- **Ports:** field in, field out.

### Morphology (`heeler.morphology`)

Erode, dilate, open or close a mask. A graph-only node: it has no Adjustments slider and no Finish layer.

- **Menu:** Masking > Mask Tools > Morphology.
- **Ports:** field in, field out.
- **Mode**: **Erode** shrinks what is selected (each pixel takes the smallest value in its window), **Dilate** grows it (the largest), **Open** erodes then dilates, which removes specks and strands narrower than the window and leaves larger shapes where they were, and **Close** dilates then erodes, which fills holes and gaps narrower than the window and leaves the outline where it was.
- **Radius**, in the photograph's pixels, 2 to start; the window reaches that far either side, so a 100 pixel square eroded by 10 is 80 pixels.
- **Shape**: **Round** (a disc, the default) or **Square**, which keeps square corners square.
- **Coverage**: **Soft** (the default) keeps the mask's gray values, so a feathered edge stays feathered and moves as a whole; **Hard** thresholds the mask at one half first, for a black and white answer.

The window stops at the frame: a mask that touches the edge of the picture neither erodes from it nor grows into it. Fit, 1:1 and the export agree.

### Guided Filter (Mask) (`heeler.guided_filter_mask`)

Settles a mask's edge onto the picture's edges: a rough selection, a luminance mask or a model's matte refined against the photograph, the way **Feather follows the picture** refines a selection. A graph-only node.

- **Menu:** Masking > Mask Tools > Guided Filter (Mask).
- **Ports:** rgb in (the guide picture), field in on the card's diamond (the mask to refine), field out. Unwired, the mask is empty and so is the answer.
- **Radius**, in the photograph's pixels, 8 to start, and **Epsilon**, 0.01 to start, as on the Guided Filter (**Detail > Blur & Smooth > Guided Filter**): where the picture is flat within the radius the mask is smoothed, where it has an edge the mask's edge moves onto it.

The guide is read in color, so an edge between two colors of the same brightness counts. The answer stays within 0 to 1, and the neighborhoods stop at the frame, so a mask touching the edge of the picture is not grown there.

### Edge Field (`heeler.edge_field`)

Where the picture changes, as a mask: white on edges and lines, black on flat areas. A graph-only node. Use it to keep sharpening off smooth skin and sky, to find the outline a mask should follow, or with Compare and Logic to build a mask of detail.

- **Menu:** Masking > Mask Tools > Edge Field.
- **Ports:** rgb in, field in on the card's diamond (optional), field out. The picture is read as its brightness on the screen's scale, so an edge's strength is the contrast you see; a field wired on the diamond is read as it is and wins over the picture.
- **Operator**: **Sobel** (the default) and **Scharr** give the strength of the change across an edge, Scharr a little rounder in every direction; **Laplacian** gives the change of the change, bright on thin lines and on both shoulders of a step and dark in a step's middle.
- **Scale**, in the photograph's pixels, 1 to start, capped at 64 photograph pixels: the edge is measured after softening the picture by that much, so a larger Scale ignores fine texture and noise and answers for broader edges.
- **Threshold** and **Softness**, both 0 to start, which leaves the field as measured: edges weaker than Threshold read black and edges stronger than Threshold plus Softness read white, with a straight ramp between. Threshold alone makes a hard black and white mask; Softness alone is a gain (0.5 doubles every edge).

A full step from black to white reads 1 at every Scale, and the field is measured in the photograph's pixels, so Fit, 1:1 and the export show the same edges. At Fit a Scale smaller than one screen pixel of the preview shows the sharpest edges the preview has.

### Median / Percentile (Mask) (`heeler.median_mask`)

A mask's specks and pinholes removed, or the mask thinned or thickened, by the median or any percentile of a round window. A graph-only node.

- **Menu:** Masking > Mask Tools > Median / Percentile (Mask).
- **Ports:** field in, field out.
- **Radius**, in the photograph's pixels, 2 to start, and **Percentile**, 50 to start, as on **Median / Percentile** (**Detail > Blur & Smooth > Median / Percentile**). At 50 specks and holes smaller than about half the window go and the outline stays put; at 0 it is Morphology's Erode with a round window, at 100 its Dilate, and in between a softer shrink or grow that ignores a few stray pixels.

The answer is exact on flat areas and at 0 and 100, and within 1/4095 elsewhere. The window stops at the frame.

### Signed Distance Field (`heeler.distance_field`)

How far each pixel is from the mask's edge, as a mask: 0.5 on the edge, rising to white at **Max distance** inside and falling to black at **Max distance** outside, in a straight line. It looks like the mask with a perfectly even feather either side, and it is a measurement: follow it with **Compare** to grow or shrink a shape by a measured number of pixels (Compare above 0.75 with Max distance 20 is the shape shrunk by 10), or with **Remap** or **Curves** to bevel or outline it. A graph-only node.

- **Menu:** Masking > Mask Tools > Signed Distance Field.
- **Ports:** field in, field out.
- **Max distance**, in the photograph's pixels, 20 to start: how far either side of the edge the field ramps. 0 gives the hard mask back.

The mask is thresholded at one half. The distance to the nearest opposite pixel center is an exact straight-line distance, with half a pixel subtracted to place a straight edge between samples. That half-pixel correction is an approximation at corners and along diagonal or soft outlines, not an exact distance to a continuous outline. A mask with no edge reads all white or all black. Distances stop at the frame. Fit, 1:1 and the export agree.
