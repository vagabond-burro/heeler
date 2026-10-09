# Detail nodes

Sharpening, smoothing, noise, grain and the film's glow, the tools that read the scene's depth, and retouching. In the add menus they sit under **Detail**, in six sections: **Sharpen & Detail**, **Blur & Smooth**, **Noise**, **Film & Lens**, **Depth** and **Retouch & Paint**. Normals from Depth, Paint and Clone / Heal wear the Utility stripe in the graph and are listed here, beside the tools they work with (**Detail > Depth > Normals from Depth**, **Detail > Retouch & Paint > Paint**, **Detail > Retouch & Paint > Clone / Heal**); the layer effects, such as **Utility > Layer Effects > Shadow**, are in the Utility chapter. Each node's **Menu** line gives its full path in the menus, category > section > node.

Sections: [Sharpen & Detail](#sharpen--detail), [Blur & Smooth](#blur--smooth), [Noise](#noise), [Film & Lens](#film--lens), [Depth](#depth), [Retouch & Paint](#retouch--paint).

## Sharpen & Detail

### Detail (`heeler.detail`)

Texture, clarity and dehaze, with per-band and per-channel weights. Adjustments' Detail section. Off and out of the graph until switched on; its node sits right after Color.

- **Menu:** Detail > Sharpen & Detail > Detail.
- **Ports:** rgb in, mask in, rgb out.
- **Texture** fine local contrast; **Clarity** mid-scale local contrast; **Dehaze** cuts or adds the veil, in luminance and color.
- **Advanced weights** use the same panel as Develop: choose Texture, Clarity, or Dehaze, then its Shadows, Midtones, Highlights, Red, Green, and Blue weights. Each runs from 0 to 200, with 100 neutral. Zero removes that contribution; 200 doubles it within the protective limits. Band and channel weights multiply, and unequal channel weights can shift hue. Dehaze weights cover both luminance and color.

The bands overlap smoothly and sum to one. In scene-linear luminance, Shadows fades out from 0 to 0.25, Highlights fades in from 0.45 to 0.85, and Midtones takes the remainder. Brightness is read before the effect, so a change does not move its own selection. Texture and Clarity read the frame after weighted luminance Dehaze. For examples, see [Advanced weights](../../adjustments/detail.md#advanced-weights).

Texture and Clarity widths follow the frame size. Their guided base reduces halos, but does not promise none. Positive and negative strengths boost and soften; neither is an undo of the other. Dehaze is a fixed neutral veil treatment in display brightness, not a spatial estimate of colored haze.

Mask it to keep clarity off skin. A graph saved before this node existed carried these dials on Color; it is split on load.

### Clarity (`heeler.clarity`)

A standalone local contrast node with Texture, Clarity, and Local contrast, each from -100 to 100.

- **Menu:** Detail > Sharpen & Detail > Clarity.
- **Ports:** rgb in, mask in, rgb out.
- **Texture** and **Clarity** use the same arithmetic and frame-relative widths as Detail when Dehaze is zero and its weights are 100.
- **Local contrast** uses a still broader scale and is available on this standalone node only.

Detail's Advanced weights are not part of this node. Zero on all three controls passes the image through unchanged.

### Sharpen (`heeler.sharpen`)

Local contrast at the fine scale: the unsharp mask. Detail's Unsharp, Radius and Threshold rows build it on the first move.

- **Menu:** Detail > Sharpen & Detail > Sharpen.
- **Ports:** rgb in, mask in, rgb out.
- **Amount**, **Radius** in pixels, **Threshold** below which flat areas are left alone.

The free-tier sharpening. The Sharpening section is a fuller treatment of its own, the Sharpening group below.

### High Pass (`heeler.high_pass`)

Only what is sharper than the radius, over mid gray, at the strength of a standard High Pass: half of the difference between the picture and its blur. A flat area comes out mid gray, an edge departs from it either side, and a tutorial's radius and result carry over.

- **Menu:** Detail > Sharpen & Detail > High Pass.
- **Ports:** rgb in, mask in, rgb out.
- **Radius**, in the photograph's pixels; the blur's sigma is the radius.

Blend it in Overlay or Soft Light over the picture for frequency-separation sharpening, or invert it and blend it in Vivid Light to soften.

### Sharpening (a group)

The Develop sharpening recipe as a group of the nodes that make it, so every step can be inspected and changed, and the group rides a layer behind its mask.

- **Menu:** Detail > Sharpen & Detail > Sharpening.
- **Ports:** rgb in, mask in, rgb out. The mask lands on the Apply mask blend at the end, in scene-linear light, so the recipe shows inside the mask and the picture outside it, and a half-covered pixel is halfway between them as it is on any other layer.
- **Inside:** To Display; Invert, Blur (Gaussian, at Radius) and a Vivid Light blend for the Vivid branch; Desaturate and High Pass (at Radius) for the Hi Pass branch; the Overlay blend whose opacity is Intensity; a Color blend of the picture over that result, whose opacity is Keep color (the same arithmetic as a Luminosity blend of the recipe, read from the other side, so that at 0 the sharpening stays and only the color is the recipe's); To Scene with the original picture as its highlight reference; Apply mask in scene-linear light. A Picture pass-through at the entrance supplies the original to those two.
- **On the group's face:** Radius, Intensity, Keep color and the Recipe switch. The switch wires one branch into the Overlay and leaves the other disabled with its settings.

The engine node `heeler.sharpening` of 2026.3 still exists for graphs saved with it; such a graph opens as the group.

## Blur & Smooth

### Blur (`heeler.blur`)

Gaussian, box or motion softening, radius in the photograph's pixels (the Gaussian's sigma), whatever size the buffer on screen is.

- **Menu:** Detail > Blur & Smooth > Blur.
- **Ports:** rgb in, mask in, rgb out.
- **Radius**, **Kind**, **Angle** for motion.

A building block used inside the Sharpening and Skin Softening groups below.

### Guided Filter (`heeler.guided_filter`)

Smooths the picture where a guide picture is flat and keeps it where the guide has an edge: edge-preserving smoothing. A graph-only node: it has no Adjustments slider and no Finish layer.

- **Menu:** Detail > Blur & Smooth > Guided Filter.
- **Ports:** rgb in, guide in (the card's second image, optional), mask in, rgb out. With the guide unwired the picture guides itself, the classic use: noise and texture flatten, outlines stay. Wire another picture as the guide (a cleaner exposure, a copy before a blur) and its edges decide where this picture's detail survives.
- **Radius**, in the photograph's pixels, 8 to start: the size of the neighborhood each pixel is smoothed over. The filter reads twice that far, which Fit, 1:1 and the export all allow for.
- **Epsilon**, 0.01 to start: how much contrast a neighborhood must hold before it counts as an edge to keep rather than texture to smooth, in display units squared (0.01 keeps steps of about a tenth of the range and more). Near 0 nothing is smoothed; larger values smooth across softer edges.

The guide is read in color, all three channels in display encoding, so two colors of the same brightness (a red flower against green leaves) still count as an edge; the picture is filtered in the same encoding and alpha passes through.

The same filter for a mask is **Guided Filter (Mask)**, **Masking > Mask Tools > Guided Filter (Mask)**.

### Median / Percentile (`heeler.median`)

Each pixel becomes the median (or any percentile) of a round window around it: dust, hot pixels and salt-and-pepper noise smaller than about half the window disappear, and straight edges stay where they were instead of blurring. A graph-only node: it has no Adjustments slider and no Finish layer.

- **Menu:** Detail > Blur & Smooth > Median / Percentile.
- **Ports:** rgb in, mask in, rgb out.
- **Radius**, in the photograph's pixels, 2 to start, capped at 200 photograph pixels: the window reaches that far each way, a disc. Fit, 1:1 and the export agree.
- **Percentile**, 50 (the median) to start: 0 takes the darkest value in the window and 100 the brightest, so a low percentile thins bright specks and lines and a high one thins dark ones.
- **Rank**: **By luminance (one pixel's color)**, the default, ranks the window's pixels by brightness and hands out one real pixel's whole color, so no color is invented and no hue shifts. **Each channel** ranks red, green and blue on their own, which cleans colored noise more thoroughly but can mix three pixels into one color.

Ranks are taken to a step of 1/2048 of the screen's range (an eighth of an 8-bit level; above white through 65536, approximately 1/128 of a stop). Negative values share the lowest bin and values above 65536 share the highest, so those ranges have no such precision bound. A flat area keeps its value exactly, and at 0 and 100 Each channel gives the exact darkest and brightest. The window stops at the frame. Alpha passes through.

The same filter for a mask is **Median / Percentile (Mask)**, **Masking > Mask Tools > Median / Percentile (Mask)**.

### Skin Softening (a group)

Smooths skin texture and brings detail back, as a group of the recipe's nodes behind a mask.

- **Menu:** Detail > Blur & Smooth > Skin Softening.
- **Ports:** rgb in, mask in, rgb out; the mask lands on the final blend inside.
- **Inside:** To Display, Invert, High Pass (Softening), Blur (Detail back), a Vivid Light blend, a Normal blend whose opacity is Strength, To Scene with an original-picture highlight reference, and Apply mask in scene-linear light. A Picture pass-through supplies the original to these branches.
- **On the group's face:** Softening, Detail back, Strength.

## Noise

### Denoise (`heeler.denoise`)

Smooth sensor noise with one strength. Detail's Smoothing row builds it on the first move.

- **Menu:** Detail > Noise > Denoise.
- **Ports:** rgb in, mask in, rgb out.
- **Strength**.

For brightness and color treated apart, use the Noise Reduction section or build the split yourself: see [Example networks](../examples.md).

### Model Denoise (`heeler.model_denoise`)

The SCUNet denoiser's answer for the photograph, blended in: Noise Reduction's **Model** method. The model runs on your machine on demand; see [Noise Reduction](../../adjustments/noise-reduction.md).

- **Menu:** Detail > Noise > Model Denoise.
- **Ports:** rgb in, mask in, rgb out.
- **Luminance** and **Chroma**: how much of the model's brightness and color answer lands. **Detail** is the section's Edge detail: the fine brightness the model took, given back where its answer shows an edge.

It sits right after the source, so the picture it sees is the one the model's answer was computed from.

### Detail Denoise (`heeler.nlm_denoise`)

Similarity-weighted smoothing that spares edges.

- **Menu:** Detail > Noise > Detail Denoise.
- **Ports:** rgb in, mask in, rgb out.
- **Strength**; **Mode** KNN (fast) or NLM (thorough).

### Hot Pixels (`heeler.hot_pixel`)

Remove stuck photosites and touch nothing else.

- **Menu:** Detail > Noise > Hot Pixels.
- **Ports:** rgb in, mask in, rgb out.
- **Sensitivity**.

## Film & Lens

### Grain (`heeler.grain`)

Film grain by tone and channel. Adjustments' Grain section.

- **Menu:** Detail > Film & Lens > Grain.
- **Ports:** rgb in, mask in, rgb out.
- **Intensity**, **Size**, **Pattern** (fine, standard, coarse, cinema), **Color grain**, and gains per band and per channel.

Add it last, after any blur, or the blur eats it.

### Grain Field (`heeler.noise`)

The grain itself, as a picture: size, stock, seed. Add it to a picture with Blend Mode.

- **Menu:** Detail > Film & Lens > Grain Field.
- **Ports:** rgb in, rgb out.
- **Size**, **Pattern**, **Color grain**, **Seed**.

### Vignette (`heeler.vignette`)

An elliptical falloff from the center: a look, not the lens fix.

- **Menu:** Detail > Film & Lens > Vignette.
- **Ports:** rgb in, mask in, rgb out.
- **Amount** (negative darkens), **Midpoint**, **Softness**.

### Halation (`heeler.halation`)

Highlights bleed a colored mist into their dark surroundings, the film's own glow.

- **Menu:** Detail > Film & Lens > Halation.
- **Ports:** rgb in, mask in, rgb out.
- **Threshold**, **Background** gain, **By depth**; **Radius**, **Diffusion** and the film **Format**; **Hue**, **Saturation**, **Blue compensation**; **Amount** and **Mix**; a secondary **Bloom** with its radius.

Scene-linear, after the flare and before the profile. Its isolated-regions view renders the gated source instead of the frame.

## Depth

### Depth Map (`heeler.depth_map`)

The photograph's near-to-far plane, tuned against the picture. Adjustments' Depth Map section. It sits at one fixed seat in the chain, after the geometry nodes and before anything tonal, and the picture passes through it untouched.

- **Menu:** Detail > Depth > Depth Map.
- **Ports:** rgb in, rgb out, depth out (the farness plane as a field, 0 near to 1 far, the diamond below the image output).
- **Edges**, **Flatten**, the **Near** and **Far** clips, the model's **Detail** size, and the plane's own **Levels**.

The map is computed from whatever is wired into the input, so what sits in front of the card is what the model reads; a file carrying its own depth pass supplies the plane instead. Every depth consumer reads the plane from the depth output by wire.

### Fog (`heeler.fog`)

Atmosphere by distance, from the depth model. Adjustments' Fog section.

- **Menu:** Detail > Depth > Fog.
- **Ports:** rgb in, mask in, rgb out.
- **Density**, **Start**, **Falloff**, fog **Level**, **Hue** and **Saturation**, **Desaturate** the far scene, and a **Texture** with size and shift.

Needs the depth model; on a machine that has not computed depth it is an identity.

### Depth Lighting (`heeler.key_light`)

Synthetic lights, suns and lamps, over the scene's depth.

- **Menu:** Detail > Depth > Depth Lighting.
- **Ports:** rgb in, mask in, rgb out.
- **Strength**, **Azimuth**, **Elevation**, **Ambient**, **Relief**, **Invert** the depth, and a list of **Lights**.

The rig has its own gizmo in the viewport.

### Depth of Field (`heeler.dof`)

Focus falls off with distance from a chosen plane.

- **Menu:** Detail > Depth > Depth of Field.
- **Ports:** rgb in, mask in, rgb out.
- **Aperture**, **Focus** distance, **Blades** and **Blade curve** for the bokeh shape, **Fringe**, **Field curve**, **Glow**, and the disc's character: **Bubble**, **Squeeze**, **Swirl**.

It is optics, so it sits with the depth tools before the profile; a blur after grading would smear the grain.

### Lens Flare (`heeler.flare`)

The lens's flare for the Depth Lighting rig's flaring lights: source glow, diffraction rays, aperture ghosts down the axis through the frame's center, the anamorphic streak with its color ribbon, and the veil. Added in scene-linear light after Depth of Field.

- **Menu:** Detail > Depth > Lens Flare.
- **Ports:** rgb in, mask in, rgb out.
- **Intensity**, **Temp**, the **Source**, **Rays**, **Ghosts**, **Anamorphic** and **Veil** groups, **Occlusion** amount and softness, and the mirrored **Lights** rig with each light's flare switch and strength.

Occlusion reads the depth plane two ways: the share of the source hidden by nearer scene dims the whole flare, and the core, rays and streak are cut per pixel where the scene is nearer than the light. Ghosts and veil form inside the lens and are not cut.

### Normals from Depth (`heeler.depth_normals`)

The surface a depth plane describes, as a normal map: each pixel's facing direction packed into red, green and blue. A graph-only node. Wire the **Depth Map**'s depth output into it, export the result with an **Export Layer** for a 3D or compositing tool, or use its channels as masks (red: facing left or right; green: facing up or down; blue: facing you).

- **Menu:** Detail > Depth > Normals from Depth.
- **Ports:** field in (the depth plane, or any mask read as a height), rgb out.
- **Reads**: **Depth (near stands up)**, the default, for the Depth Map's plane, where black is near; **Height (white stands up)** for a mask or a painted height map.
- **Strength**, 2000 to start: how tall a full step from black to white stands, in the photograph's pixels. The slope is measured per photograph pixel, so Fit, 1:1 and the export show the same normals; double the Strength and every tilt's steepness doubles.
- **Cliff**, 0.15 to start: a jump between neighboring pixels bigger than this (as a share of the field's full range) is an edge between two surfaces, not a slope. Each side keeps its own slope right up to the edge, so a silhouette is a clean one-pixel seam instead of a smeared band of sideways normals. Raise it to 1 to treat every jump as a slope.

The convention is the one Depth Lighting reads a render's normals in: x to the right, y down the picture, z toward you, each packed as (n + 1) / 2. Flat ground facing you is (0.5, 0.5, 1), a light blue; a surface rising to the right faces left and reads less red. For a tool that wants y up, invert the green channel. A cliff narrower than one pixel of the reduced preview can soften into a slope at Fit; 1:1 and the export show it as it is.

## Retouch & Paint

### Inpaint (`heeler.inpaint`)

The model fills the hole a mask describes, computed locally on demand.

- **Menu:** Detail > Retouch & Paint > Inpaint.
- **Ports:** rgb in, mask in (the hole), rgb out.
- **Hole** from the wire or from the layer; the fill and model ids are managed by the app.

The Remove tool builds one; wire any mask as the hole to use it by hand.

### Paint (`heeler.paint`)

RGBA strokes on a transparent canvas: the Finish tab's pixel layer.

- **Menu:** Detail > Retouch & Paint > Paint.
- **Ports:** rgb in, rgb out.
- **Strokes**; **Heal** reads texture from the source.

### Clone / Heal (`heeler.clone`)

Repairs that re-execute: strokes that read pixels from elsewhere in the frame.

- **Menu:** Detail > Retouch & Paint > Clone / Heal.
- **Ports:** rgb in, rgb out.
