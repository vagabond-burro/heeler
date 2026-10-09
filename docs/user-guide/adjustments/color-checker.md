# Color Checker

Color Checker is a camera calibration: photograph a reference chart in the
same light as the subject, and Heeler fits the white balance, an exposure
correction, and a 3x3 color matrix that bring the chart's measured patches
onto its published values. The section sits at the bottom of the
Adjustments panel, below Lens, and corrects the camera before any grading:
in the graph its node runs after the warps and the Depth Map, before
Color.

## The workflow

1. **Shoot the chart** in the light you are working in, square on if you
   can, large enough that each patch is a clean area. One frame with the
   chart is enough for the whole session.
2. **Pick the chart** from the section's menu: ColorChecker Classic,
   Passport, and SG, in both the current and the pre-November 2014
   printings, and Datacolor SpyderCHECKR 24 and 48. The values are the
   makers' published ones.
3. **Place chart** shows the chart grid over the photograph. Drag the
   four corners onto the chart's corners; a tilted chart reads square-on.
   Click a patch to leave it out of the fit (a second click brings it
   back), and drag a patch to nudge its center when a print has drifted
   off its grid.
4. **Calibrate** samples each patch and fits. **White balance** says
   where the fit's temperature and tint go: **To node** writes them to
   the Color section's white balance, where you can still move them,
   and the matrix carries none of it; **In matrix** leaves that node
   alone and folds the same gains into the matrix. **Amount** fades the
   whole correction.

The section is laid out as the work goes: the chart and its placement
first, then the calibration and what to do with it, then the look of
the chart lines over the photograph.
5. **Save calibration** names the result and keeps it under Calibrations
   in the Presets tab. Applying one to another photograph from the same
   camera and light is one click from the section's menu; if the saved
   camera differs from the photograph's, the section says so and applies
   anyway.

## The sample area

Each patch's reading comes from a circle at its center, drawn over the
photograph as the ellipse that circle becomes under the chart's tilt.
**Sample** sets the circle's size, 10 to 90 percent of the patch, 40 to
start, in the section and on the node alike. Dragging any circle's rim
sizes every circle together, with the number showing while you drag.
Smaller circles sit tighter on small patches; larger ones average more
of a patch that printed unevenly. Calibrate measures exactly the region
the overlay draws, so what you see is what the fit reads.

## The lines

The grid, the circles and the corner handles draw in the shared line
color and thickness, the same settings Shape Warp's outlines use. The
**LINES** row picks a hue and brightness or leaves them automatic (the
opposite of the photograph's own average), and **THICKNESS** overrides
the preference for this photograph alone. One setting serves every
tool, so a color chosen here is there for the warps, and vice versa.

## Reading the report

The report under the buttons is the fit's account of itself: the mean
**dE** (CIEDE2000) across the fitted patches, the worst patches first
with a before and after swatch pair each, and a guess at the illuminant
from the fitted temperature. Under a dE of 1 is below what an eye
separates; single digits are a good fit. A patch outlined dashed in the
grid was **flagged**: *clip* means its reading climbed toward the white
patch, so it is likely clipped or flared, and *glare* means the sample
circle caught an edge or a reflection. Flagged patches are left out of
the fit. The last line is the provenance: which camera the fit was made
on, and when.

The fit needs at least one gray patch for the white balance and four
usable patches with three chromatic ones for the matrix. With fewer it
fits the white balance and exposure alone, leaves the matrix at identity,
and the report's note says so.

## Custom charts

A card of your own, or a chart Heeler does not ship, calibrates the same
way. **Custom chart...** opens the editor over the photograph: set the
rows and columns (the fields drag sideways like every other number, or
type), click a cell, and give it a target. The palette lists every patch
of every built-in chart, the Classic's 24 first, grouped under their
source chart, with a filter once the list runs long. A color of your
own types as sRGB hex or as Lab from the card's datasheet: the two modes
convert into each other, and the swatch shows live what the fit will aim
at. **Clear** empties a cell again; a cell with no target is ignored by
the fit. Without a gray control the editor warns that white balance
cannot be fitted; a white or near-white control also lets the fit spot
clipped patches. The chart saves beside the built-ins and lives as one
JSON file in the `charts` folder of the presets library; the editor's
**Import** and **Export** share chart files the way the Presets tab
shares looks.

The same sampler, the same fit, and the same report apply to a custom
chart, and a calibration fitted on one saves and applies like any other.
