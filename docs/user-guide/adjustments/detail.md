# Detail

Detail contains quick texture, local contrast, haze, sharpening, and smoothing controls. Some controls follow the selected Develop layer, making this the place for masked detail work.

Detail is off by default and has no node until its switch builds one. Texture, Clarity and Dehaze live on the Detail node, which sits right after Color in the graph; Unsharp, Radius, Threshold and Smoothing build a Sharpen or Denoise node the first time they move. The section's switch bypasses all of them.

## Controls

- **Texture** emphasizes or softens fine structures.
- **Clarity** changes mid-scale local contrast.
- **Dehaze** reduces a neutral veil and restores color, or adds a neutral veil at negative values. It is a contrast and color treatment, not a measurement of the atmosphere.
- **Unsharp** sets ordinary unsharp-mask strength.
- **Radius** sets the width of sharpening edges.
- **Threshold** protects flatter areas from sharpening: it measures the detail under an edge rather than the edge itself, so raising it reaches fewer edges too.
- **Smoothing** applies a single noise-smoothing strength.

Use Texture for fine detail and Clarity for larger local contrast. Raise Threshold to keep Unsharp away from skin or smooth sky. Keep Smoothing modest; for separate luminance and chroma treatment use [Noise Reduction](noise-reduction.md).

Texture and Clarity use edge protection to reduce halos. Their widths follow the frame, so a full-size export treats the same structures as the preview. Strong settings can still emphasize noise and draw broad bands beside transitions. Negative values soften detail; they do not undo a previous positive pass.

## Equalizer

Open **EQUALIZER** under the sliders to raise or lower contrast at five scales of detail, the way [Tone Equalizer](tone-equalizer.md) raises or lowers brightness by zone. The strip at the top draws the five settings as one line, from fine on the left to broad on the right.

- **Fine** is the finest texture: pores, film grain, fabric, noise.
- **Small** is small detail: leaves, hair, feathers, gravel.
- **Medium** is medium structure: branches, rocks, the features of a face.
- **Large** is large forms: buildings, hillsides, clouds.
- **Broad** is the light across whole areas of the frame.

Raise a band to bring out detail at that scale and lower it to soften it; at -100 the band is taken out. Unlike Texture and Clarity, the bands can go in opposite directions at once: lift Medium to give rock and bark more relief while lowering Fine to calm noise or skin texture. The bands use the same edge-aware filter as Texture and Clarity, so a raised band does not draw a halo along a hard edge, and their widths follow the frame, so the preview and the export match.

The eye beside each band shows that band alone on the canvas, as gray texture around a middle gray: what lights up is what that band will change. Click it again, or another view, to go back to the photograph. The view is only a view: it is not saved and never reaches an export. It works once the Equalizer is in use, after the first band moves.

**WEIGHTS** opens the same six weights as Advanced below, shared by all five bands: Shadows, Midtones and Highlights by brightness, Red, Green and Blue by channel. **Even** puts them back to 100.

The Equalizer is its own node, Detail Equalizer, built right after Detail the first time a band or weight moves. Existing edits are untouched. It follows the selected Develop layer like the rest of Detail, the section's switch bypasses it with the rest, and the section's reset puts its bands and weights back to zero and 100.

## Advanced weights

Open **ADVANCED**, choose **Texture**, **Clarity**, or **Dehaze**, then adjust that effect's six weights. The badge counts effects with any weight changed from 100. **Even** restores the selected effect's weights. The same controls and values appear on the Detail node in Graph mode. Opening the fold or choosing an effect changes only the panel, not the photograph; those choices are not saved in the edit.

**Shadows**, **Midtones**, and **Highlights** are overlapping brightness ranges, with smooth transitions. They describe the incoming brightness, not a hard selection. **Red**, **Green**, and **Blue** scale the change in each channel. Unequal channel weights can change hue.

- **0** removes the selected effect's contribution from that band or channel. It does not invert the effect. Neighboring bands can still contribute in a transition.
- **100** keeps the strength set by the main slider.
- **200** doubles that contribution, until shadow protection or the black boundary stops further darkening. Band and channel weights multiply: setting both to 200 can give four times the contribution.

For skin, start with a modest negative Texture and lower **Texture > Highlights** to protect bright skin from further softening. For positive Texture on clothing and hair, lower Highlights to hold bright skin out of the added texture. This is a brightness adjustment, not skin detection; use a layer mask when you need to isolate the face. To keep Clarity off dark areas, lower **Clarity > Shadows** toward 0. Dehaze weights affect both its brightness and color treatment.

When a local-adjustment layer is selected, the quick Unsharp and Smoothing controls operate behind that layer's mask, and so do the Sharpening and Skin Softening sections. The Noise Reduction recipe remains global.

![Detail at 100%](../assets/screenshots/section-detail.png)
