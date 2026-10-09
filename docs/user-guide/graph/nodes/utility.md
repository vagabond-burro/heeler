# Utility nodes

Channels, math and logic, color spaces, compositing and the content nodes behind Finish layers, the layer effects, and the output. In the add menus they sit under **Utility**, in six sections: **Channels**, **Math & Logic**, **Color Space**, **Composite**, **Layer Effects** and **Output**. Measure, Compare and Logic wear the Masking stripe and are listed here with the math they feed; Gamut Map wears the Color stripe. Gamut Map is **Utility > Color Space > Gamut Map**. Utility-striped nodes listed elsewhere: **Source > Geometry > Transform**, **Source > Geometry > Displacement Map**, **Detail > Depth > Normals from Depth**, **Detail > Retouch & Paint > Paint**, **Detail > Retouch & Paint > Clone / Heal** and **Masking > Range Masks > Tone Mask**. Each node's **Menu** line gives its full path in the menus, category > section > node.

Sections: [Channels](#channels), [Math & Logic](#math--logic), [Color Space](#color-space), [Composite](#composite), [Layer Effects](#layer-effects), [Output](#output).

## Channels

### Channel (`heeler.channel_extract`)

One channel as a field: luma, red, green or blue.

- **Menu:** Utility > Channels > Channel.
- **Ports:** rgb in, field out.

### Luminance Extract (`heeler.luminance_extract`)

Brightness as a field. The quickest way from a picture to a mask.

- **Menu:** Utility > Channels > Luminance Extract.
- **Ports:** rgb in, field out.

### Channel Join (`heeler.channel_join`)

Three fields become an image: r, g and b in, rgb out. The ports wear their channel's color.

- **Menu:** Utility > Channels > Channel Join.
- **Ports:** red plane, green plane, blue plane (fields), alpha plane (a field, the diamond on the bottom edge), rgb out.

An unwired plane reads as zero; an unwired alpha is opaque. Measure's **Alpha** metric on the alpha plane keeps a picture's transparency when you take it apart and join it again. Feed it three Measures for a false-color analysis, or rebuild a picture from remapped channels.

### Channel Gain (`heeler.channel_gain`)

More or less of one channel; 100 is unchanged.

- **Menu:** Utility > Channels > Channel Gain.
- **Ports:** rgb in, mask in, rgb out.
- **Channel** luma, red, green or blue; **Gain**.

### Channel Mixer (`heeler.channel_mixer`)

Each output channel rebuilt from all three inputs.

- **Menu:** Utility > Channels > Channel Mixer.
- **Ports:** rgb in, mask in, rgb out.
- Nine **mix** weights; **Preserve gray** keeps neutrals neutral.

### Luma / Color Split (`heeler.luma_chroma_split`) and Join (`heeler.luma_chroma_join`)

Brightness or color on its own, so noise in each can be smoothed apart, and the two put back together.

- **Menu:** Utility > Channels > Luma / Color Split; Utility > Channels > Luma / Color Join.
- **Split ports:** rgb in, rgb out; **Part** luma or color.
- **Join ports:** brightness (rgb), color (rgb), rgb out.

The Noise Reduction section is built from these two and two Denoise nodes.

### Alpha Association (`heeler.alpha_association`)

Extracts a picture's transparency as a grayscale image, replaces it with a field of yours, or premultiplies and unpremultiplies its color, so a cut-out composites cleanly and a file reads the way its compositor expects. A graph-only node.

- **Menu:** Utility > Channels > Alpha Association.
- **Ports:** rgb in, alpha in (the diamond, optional), rgb out.
- **Mode**: **Replace alpha** (the default) makes the mask on the alpha diamond the picture's transparency, exactly, the color untouched; with nothing wired it hands the picture through. **Extract alpha** shows the transparency as a gray picture, white where it is opaque; follow it with **Channel** or **Luminance Extract** to use it as a mask. **Premultiply** multiplies the color by the alpha. **Unpremultiply** divides it back out, and where the alpha is zero (or all but zero) leaves the color as it is, so color hidden under a fully transparent area survives.

Every wire in a Heeler graph carries straight (unpremultiplied) color: an OpenEXR's premultiplied color is divided out when it is read, and the EXR export multiplies it back in when it is written. So never use this node to fix a file's alpha; Heeler already has. **Premultiply** is for a recipe that wants premultiplied arithmetic (a compositor's Add or Screen of a glow element), and nothing marks the result, so put an **Unpremultiply** after that work and before anything that blends, masks or exports, the two as a pair.

## Math & Logic

### Measure (`heeler.measure`)

The picture as numbers: luma, a channel, hue, chroma, saturation or alpha (its transparency), as a field.

- **Menu:** Utility > Math & Logic > Measure.
- **Ports:** rgb in, field out.
- **Metric**, **Smoothing** as a blur radius on the measurement.

The start of every condition, and a plane for Channel Join.

### Compare (`heeler.compare`)

Where a field passes a threshold, feathered: the Blend If handles as a node.

- **Menu:** Utility > Math & Logic > Compare.
- **Ports:** field in, field out.
- **Op** (>, ≥, <, ≤, = or ≠; a recipe file writes them gt, ge, lt, le, eq and neq), **Level**, **Softness** as the feather either side of the level.

### Logic (`heeler.logic`)

Two conditions combined.

- **Menu:** Utility > Math & Logic > Logic.
- **Ports:** field a, field b, field out.
- **Op** and (minimum), or (maximum), xor (difference), subtract.

With one operand wired it passes that operand through.

### Conditional (`heeler.conditional`)

If the condition holds, the then branch; else the else branch, per pixel.

- **Menu:** Utility > Math & Logic > Conditional.
- **Ports:** else branch (rgb), then branch (rgb), condition (field), rgb out.

A feathered condition from Compare crossfades the branches. No condition wired, or the node switched off, is the else branch. See [Example networks](../examples.md).

### Math (`heeler.math`)

Arithmetic on fields.

- **Menu:** Utility > Math & Logic > Math.
- **Ports:** operand a, operand b (field), field out.
- **Op** add, multiply, divide, power and the rest; **Constant** stands in for b when b is unwired; **Scale** and **Offset** on the result, unclamped.

With nothing wired it is a constant field.

### Remap (`heeler.remap`)

Levels for a field: window, gamma, output range.

- **Menu:** Utility > Math & Logic > Remap.
- **Ports:** field in, field out.
- **In low/high**, **Gamma**, **Out low/high**, **Clamp**.

### Invert (`heeler.invert`)

One minus the value, by amount.

- **Menu:** Utility > Math & Logic > Invert.
- **Ports:** rgb in, mask in, rgb out.

## Color Space

### Gamut Map (`heeler.gamut_map`)

Ease colors no display can show back inside, hue held.

- **Menu:** Utility > Color Space > Gamut Map.
- **Ports:** rgb in, mask in, rgb out.
- **Amount**.

The viewport's gamut warning offers to insert one after the node responsible.

### To Display (`heeler.to_display`) and To Scene (`heeler.to_scene`)

Into display space, where Overlay and Vivid Light are defined, and back to scene-linear afterwards.

- **Menu:** Utility > Color Space > To Display; Utility > Color Space > To Scene.
- **Ports:** rgb in, rgb out.
- **Gamma** overrides the transfer; 0 uses the standard curve.

Always use them as a pair around the blend. To Scene also has an optional second image input: connect the original scene-linear picture to preserve its values above white through a display-space recipe. Leave it unwired for the ordinary inverse transfer.

### Color Transform (`heeler.color_transform`)

Converts the picture's numbers between declared color spaces. A graph-only node. Heeler's wires carry linear light with the Rec. 709 (sRGB) primaries; use a pair of these around work that wants another space: a grade in ACEScct, a 3D LUT built for Rec. 2020 or Display P3, a log look, then back.

- **Menu:** Utility > Color Space > Color Transform.
- **Ports:** rgb in, mask in, rgb out.
- **From** and **To**: **Linear Rec. 709 (Heeler's working space)**, **sRGB** (the sRGB curve), **Linear Rec. 2020**, **ACEScg**, **ACEScct** (ACEScg's primaries with the ACEScct log curve), **ACES2065-1**, **Linear Display P3** and **Display P3** (the sRGB curve). Linear Rec. 709 to ACEScg to start; From and To the same hands the picture through. Leave **From** at Linear Rec. 709 unless a Color Transform earlier in the graph converted the picture: the picture on Heeler's wires is already linear, so choosing sRGB there decodes it a second time and darkens it.

The conversion undoes the From space's curve, moves the primaries with one 3x3 matrix built from each space's published primaries and white (Bradford adaptation between the ACES white and D65), and applies the To space's curve. There and back again returns the same numbers to within a hundred-thousandth. Colors outside the To space's gamut come out with negative channels; nothing is clipped or mapped, so follow with **Gamut Map** or **Technical Soft Clip** when the next step needs the range. ACEScct encoding preserves values above 65504; its specified inverse caps them at 65504 in linear light. Alpha passes through.

## Composite

### Merge (`heeler.merge`)

Lay one image over another by opacity: the plain composite.

- **Menu:** Utility > Composite > Merge.
- **Ports:** base, over (rgb), rgb out.
- **Opacity**; **Fit** for a second picture of another shape: Fit keeps it whole inside the frame, Fill covers the frame, Stretch pulls it to the frame, None places it at its own size. A new node starts on Fit; one saved before the choice existed keeps stretching.

With nothing on the second input the base passes through.

### Blend Mode (`heeler.blend`)

Combine two images by a mode. The carrier of every Finish layer.

- **Menu:** Utility > Composite > Blend Mode.
- **Ports:** base, top layer (rgb), mask in (where it applies), clip (a stencil), rgb out.
- **Mode** multiply, screen, overlay, soft light, hard light, vivid light, linear light, add, darken, lighten, difference, exclusion, color burn and dodge, hue, saturation, color, luminosity; **Opacity**; **Fit** as on Merge; **Clip** to the base's alpha; and the layer transform's corners, which the Transform tool in Finish writes.

Overlay and the light modes are defined in display space: put To Display before and To Scene after when blending scene-linear branches.

### Lift (`heeler.lift`)

The picture below, as this layer's own pixels. Finish's Isolate.

- **Menu:** Utility > Composite > Lift.
- **Ports:** rgb in, rgb out.

### Fill (`heeler.fill`)

A solid color, for a fill layer and its mask.

- **Menu:** Utility > Composite > Fill.
- **Ports:** rgb in, rgb out.
- **Color**.

### Gradient (`heeler.gradient`)

Two stops with alpha, or a list of stops, across the frame (Linear or Radial) or **By tone**, where each pixel's brightness on the input picks its color, darks at the first stop and brights at the last. The Inspector has the Finish Gradient layer's controls, **ADV** opening the stop list under them.

- **Menu:** Utility > Composite > Gradient.
- **Ports:** rgb in, rgb out.
- **Color A/B**, **Alpha A/B**, **Angle** (not By tone), **Shape**, **Midpoint**, **Stops**.

## Layer Effects

Each is a function of a layer's alpha, so they work on any node that carries transparency, not only in Finish.

- **Shadow (`heeler.fx_shadow`)**, Utility > Layer Effects > Shadow: drop or inner shadow cast from the layer's own shape.
- **Glow (`heeler.fx_glow`)**, Utility > Layer Effects > Glow: outer or inner glow, with no offset to fall by.
- **Color Overlay (`heeler.fx_color_overlay`)**, Utility > Layer Effects > Color Overlay: a flat color kept inside the layer's alpha, with opacity.
- **Gradient Overlay (`heeler.fx_gradient_overlay`)**, Utility > Layer Effects > Gradient Overlay: a gradient kept inside the layer's alpha: two colors, angle, shape, midpoint, or a list of stops.
- **Bevel / Emboss (`heeler.fx_bevel`)**, Utility > Layer Effects > Bevel / Emboss: light the layer as though its alpha were a hill: size, depth, angle, opacity, highlight and shadow colors.

## Output

### Output (`heeler.output`)

What gets exported. Every graph ends here; it cannot be deleted or duplicated.

- **Menu:** Utility > Output > Output.
- **Ports:** rgb in, alpha (field, the export's transparency; a wire here wins over the Export panel's Matte toggle and needs PNG, TIFF or EXR to carry it).
- **Format**, **Quality**, **Long edge**, **Color space** are the defaults Export starts from.

### Export Layer (`heeler.export_layer`)

Writes one extra layer with the export: a mask, a depth plane, or a color plane, under a name you choose. It renders nowhere in the graph; it is read only when an export runs.

The node passes its wired input through unchanged, so you can drop it onto any wire to tap what flows there without rewiring: the picture continues downstream exactly as before.

- **Menu:** Utility > Output > Export Layer.
- **Ports:** image (rgb in and out, exported as color planes) or gray (field in and out: any mask, or Depth Map's farness plane). One pair at a time; wiring one lets the other go. The **alpha** input (field) names the written layer's transparency, replacing the alpha the wire carried; unwired, the wire's own alpha is written.
- **Name** is the layer's name in the file; empty uses the card's label without a trailing ` Export Layer`, so the card an Export checkbox names `Curves Export Layer` writes `Curves`. **Part** chooses color planes (R, G, B) or a single gray for an image input.
- **Source** says where the node came from: empty for one you placed by hand, `finish:<layer id>` for one the Finish tab's Export checkbox created (named `<layer> Export Layer`), `finishmask:<layer id>` for a Finish layer's Export Mask as Layer (`<layer> Mask Export Layer`), `layermask:<layer id>` for the same box on an adjustment layer in Adjustments (`<layer> Mask Export Layer`), `develop:<section>` for an Adjustments section's checkbox (`<section> Export Layer`). You never need to type it.

TIFF exports write each layer as a sibling file next to the beauty (`photo.sky.tif`): a mask or depth tap writes a gray at the beauty's bit depth, an image tap writes RGBA. EXR packs every layer into the one file as named layers, depth as a 32-bit float Z. Other formats cannot carry extra layers; the panel warns and the log names what was dropped. A Smart mask arrives at export size, its preview raster resampled up; refine the mask or bake it when pixel-exact edges matter.

## Groups

A group card holds a graph of its own and shows its inputs, one output and any controls it publishes. Double-click to open it. Groups are made from a selection, or dropped from the palette's **Recipes**; see [Node recipes](../recipes.md).
