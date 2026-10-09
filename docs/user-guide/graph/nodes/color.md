# Color nodes

Tone, white balance, grading, curves, and the transforms that render scene light for the screen. All work in scene-linear light unless the node says otherwise; the Tone Profile or View Transform is where the picture becomes what the screen shows, so Curves belongs after it and everything else before. In the add menus they sit under **Color**, in three sections: **Tone**, **Color** and **Looks**. Gamut Map is **Utility > Color Space > Gamut Map**, with the other color space nodes. Each node's **Menu** line gives its full path in the menus, category > section > node.

Sections: [Tone](#tone), [Color](#color), [Looks](#looks).

## Tone

### Exposure (`heeler.exposure`)

Brightness, contrast and the tonal ends. Adjustments' Exposure section. Ships on.

- **Menu:** Color > Tone > Exposure.
- **Ports:** rgb in, mask in, rgb out.
- **Exposure** in stops; **Contrast** around middle gray; **Color contrast** the same for color alone; **Highlights**, **Shadows**, **Whites**, **Blacks** move the ends and the quarter tones.

The first correction on most frames. Mask it for local exposure, or add a Develop layer, which is an Exposure node with a mask.

### Levels (`heeler.levels`)

Black point, white point, gamma, and a softness for each end.

- **Menu:** Color > Tone > Levels.
- **Ports:** rgb in, mask in, rgb out.
- **Black** and **White** are the input points in 0 to 1; **Gamma** bends the middle; **Black soft** and **White soft** roll the clip instead of cutting it.
- In the Inspector the histogram with its five handles sits above the rows, the same control as **Adjustments > Levels**.

Use it for a hard technical stretch; use Curves for shaping.

### Curves (`heeler.curves`)

A freehand tone curve, per channel (RGB, red, green, blue). Adjustments' Curves section.

- **Menu:** Color > Tone > Curves.
- **Ports:** rgb in, mask in, rgb out.
- **Points** are dragged in the editor; Smooth, Straight or Tangent interpolation; a picker sets points from the photograph.

It sits after the Tone Profile on purpose: the curve's axis is the screen's tonality, so a point at 0.9 is a bright screen value.

### Relight (`heeler.tone_eq`)

Re-expose by brightness zone: nine zones one stop apart, each with its own lift or cut.

- **Menu:** Color > Tone > Relight.
- **Ports:** rgb in, mask in, rgb out.
- **Zones** from four stops under middle gray to four over, in stops; **Range shift** slides the zones; **Smoothing** blends between them.

Lift the shadows without touching the sky, or the reverse. Exposure work, so it sits right after Exposure.

### Technical Soft Clip (`heeler.soft_clip`)

Keeps values under a ceiling without a hard edge, and touches nothing else. A graph-only node: it has no Adjustments slider and no Finish layer. Use it where the next step needs a range (a 3D LUT built for 0 to 1, a log encoding that has no negatives, an 8-bit export of an HDR render), not as a look.

- **Menu:** Color > Tone > Technical Soft Clip.
- **Ports:** rgb in, mask in, rgb out.
- **Ceiling**, in scene-linear values, 1 to start: nothing comes out above it.
- **Knee**, a share of the ceiling, 0.2 to start: where the roll-off begins, so at 0.2 everything below 0.8 of the ceiling is exactly as it was and everything above is rolled smoothly into the last fifth, the steeper the further past. 0 is a hard clip.
- **Toe**, a scene-linear width above zero, 0 (off) to start: under it values roll smoothly down toward zero and never below it, so the negative values a color conversion leaves behind come back into range. Above the toe nothing moves.
- **By**: **Brightest channel (hue kept)**, the default, scales all three channels of a pixel by what the knee does to the largest, so the color's hue and saturation are kept exactly. **Each channel** rolls the three apart, the way film and sensors clip: bright saturated colors drift toward the primaries and white (an orange sunset goes yellow). By brightness alone is not offered, because a color under the ceiling in brightness can still hold a channel far above it.

How it differs from its neighbors: **Levels**' soft ends reshape everything between its black and white points, and a **View Transform** or the **Tone Profile** is a curve over the whole range that changes every value and the contrast. This node is the identity below the knee and above the toe.

### Tone Profile (`heeler.tone_profile`)

The base rendering and the highlight shoulder: what makes a decoded RAW look developed. Ships on, right before Output.

- **Menu:** Color > Tone > Tone Profile.
- **Ports:** rgb in, mask in, rgb out.
- **Mode** Linear, Standard or Film; **Baseline** lift in stops; **Profile amount** scales the curve; **Toe** keeps blacks dense; **Highlight roll** compresses into white; **Colorfulness**.

Exposure and Color come before it because they are linear operations; Curves comes after because it shapes the screen picture.

### View Transform (`heeler.view_transform`)

The scene-to-display rendering, chosen: sigmoid, filmic, AgX or ACES. Use it instead of Tone Profile.

- **Menu:** Color > Tone > View Transform.
- **Ports:** rgb in, mask in, rgb out.
- **Mode**, **Exposure** in stops, **Contrast** as the slope around gray, **White** in stops above gray.

Bypass the Tone Profile when you add one, or the picture is rendered twice.

## Color

### Color (`heeler.standard_color`)

Temperature, tint, saturation and vibrance. Adjustments' Color section. Ships on.

- **Menu:** Color > Color > Color.
- **Ports:** rgb in, mask in, rgb out.
- **Temp** and **Tint** set white balance in Kelvin and green/magenta; **Saturation** scales all color; **Vibrance** favors the colors that are not already strong.

White balance belongs here, before any grading. The section's Black & White treatment is its own node, wired after this one.

### White Balance (`heeler.white_balance`)

Temperature and tint alone, for a second neutralization somewhere else in the chain.

- **Menu:** Color > Color > White Balance.
- **Ports:** rgb in, mask in, rgb out.

Use it with a mask for mixed lighting, or Chromatic Adaptation for the same job with a color model behind it.

### Color Balance (`heeler.color_balance`)

Push shadows, midtones and highlights toward a hue. Adjustments' Color Wheels.

- **Menu:** Color > Color > Color Balance.
- **Ports:** rgb in, mask in, rgb out.
- Per range: **Hue**, **Saturation**, **Luminance**.

Classic three-way grading. Keep the three wheels small; they add up.

### Color Bend (`heeler.color_bend`)

Move one neighborhood of color to another.

- **Menu:** Color > Color > Color Bend.
- **Ports:** rgb in, mask in, rgb out.
- **Source** hue and saturation, **Destination** hue and saturation, **Falloff** as a fraction of the wheel, **Amount**.

The node is off until the destination leaves the source. Use it to turn one green into another without touching the rest.

### Color Grade (`heeler.color_grade`)

Hue shift, chroma, exposure and uniformity in OkLCh, centered on a hue band. The grading half of a Color Set.

- **Menu:** Color > Color > Color Grade.
- **Ports:** rgb in, mask in, rgb out.
- **Hue shift**, **Saturation**, **Vibrance**, **Exposure**, **Uniformity** pulls the band's hues together; **Band center** names the hue; per-channel curves ride along.

Pair it with a Hue Range Mask, which is what Color Sets do for you.

### Recolor (`heeler.recolor`)

The channel-routing color EQ: select by hue, saturation, luminance, depth, the hue of the surroundings, a mask's coverage, or hue and luminance together as a surface; adjust hue, saturation, luminance, pastel (the mix toward white), temperature, tint or vibrance. Every pairing is a curve, bar the surface, which is a grid.

- **Menu:** Color > Color > Recolor.
- **Ports:** rgb in, mask in, and a **by** mask input that the Mask row reads as its axis, rgb out.
- **Curves** per cell and **Surfaces** per output; **Neutral guard** keeps grays out of hue-driven cells; **Smoothing** softens the selection; **Around radius** is the surroundings' reach; the hue→hue cell's **Spread** verb reads its curve as hue contrast.

Hue against hue is a hue shift by hue; luminance against saturation desaturates the shadows; and so on.

### Color Tune (`heeler.color_console`)

Per-family grading strips: red, green, blue, cyan, yellow, magenta, plus bands you pick, each with a wheel.

- **Menu:** Color > Color > Color Tune.
- **Ports:** rgb in, mask in, rgb out.
- **Bands** carry each strip's hue, saturation and luminance; **Smoothing** blends between neighboring families.

The quick way to lift one family of color; Recolor is the precise way.

### Chromatic Adaptation (`heeler.chromatic_adapt`)

CAT16: undo the color of the light itself.

- **Menu:** Color > Color > Chromatic Adaptation.
- **Ports:** rgb in, mask in, rgb out.
- **Illuminant** (custom, D65, D50, A, F2) or a **Temperature**; **Strength** fades it.

Mask it for mixed lighting: tungsten inside, daylight through the window.

### Chroma Key (Despill) (`heeler.chroma_key_despill`)

Takes a key color's spill out of the picture: the green a green screen throws onto hair, edges and skin. A graph-only node; its partner, **Chroma Key** (**Masking > Range Masks > Chroma Key**), makes the matte.

- **Menu:** Color > Color > Chroma Key (Despill).
- **Ports:** rgb in, mask in, rgb out.
- **Key r**, **Key g**, **Key b**: the screen's color, as on Chroma Key (set both nodes the same).
- **Spill**, 1 to start: how much of each pixel's lean toward the key's hue is taken out. At 1 a pixel tinted toward the key goes neutral; at 0.5 half the tint goes; 0 hands the picture through.

Brightness is kept, and a color that leans away from the key (a magenta, a skin tone against green) is not touched at all. Like any despill it also mutes subject colors close to the key's hue: a green shirt in front of a green screen loses its green. Alpha passes through.

## Looks

### Black & White (`heeler.black_white`)

Channel-mixer monochrome. Color's Treatment switch builds it.

- **Menu:** Color > Looks > Black & White.
- **Ports:** rgb in, mask in, rgb out.
- **Red**, **Green**, **Blue** are the mixer weights; **Amount** fades between color and mono, so the switch is a fade, not a cut.
- **Hue curve** is a periodic curve of hue (OkLCh degrees) to EV, in Relight's point format, scaling the mixed gray per hue, up to two stops either way; neutrals are gated out. Empty is the mixer alone.

Raise Red for skin, Blue for skies going dark, the way a filter on a mono film would; shape the curve for a single color the mixer cannot reach alone. With the treatment on, a hue-keyed mask downstream (Hue Range, Color Range) is fed from this node's input in the rendered graph, so it can still select by color.

### Desaturate (`heeler.desaturate`)

Take the color out, keep the brightness.

- **Menu:** Color > Looks > Desaturate.
- **Ports:** rgb in, mask in, rgb out.
- **Amount** from 0 to 1.

A utility for branches: a desaturated copy for a luminosity blend, say.

### Gradient Map (`heeler.gradient_map`)

Brightness decides color: three stops from shadows to highlights.

- **Menu:** Color > Looks > Gradient Map.
- **Ports:** rgb in, mask in, rgb out.
- **Low**, **Mid**, **High** colors, **Midpoint**, **Amount**.

Duotones and toning. Mask it to keep the effect off skin.

### Print (`heeler.paper`)

The paper the print is made on: Adjustments' [Print](../../adjustments/print.md) section. In the display domain, last before Output.

- **Menu:** Color > Looks > Print.
- **Ports:** rgb in, mask in, rgb out.
- **Grade** (2 to start) and **Time**, or **Split** grade with its soft and hard times; the paper's black (**Dmax**) and **Base**; a **Toner** with its amount and crossover.

### 3D LUT (`heeler.lut`)

A `.cube` look-up table from disk, applied to the display-encoded picture.

- **Menu:** Color > Looks > 3D LUT.
- **Ports:** rgb in, mask in, rgb out.
- **Path** and **Amount**.

Film emulations and grades from elsewhere. The graph's own color branches can be baked to a LUT from the context menu.
