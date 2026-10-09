# Lens Character

Lens Character is a vintage lens as one setting. Below Depth of Field, pick a
lens and its character is written across the optical sections at once: Depth
of Field's bokeh (blades, bubble, squeeze, swirl, field curvature, fringe,
glow), Lens Correction's distortion and color fringing, Vignette, Halation,
Detail's texture, a coating curve in Recolor, and the Lens Flare's veil and
ghosts. One undo step takes the whole character off again.

Nothing is applied until you choose. Heeler suggests a lens when the
photograph's own lens name matches one, and marks it in the menu. The
sections a character writes keep their fold, open or closed, and each
one's switch shows it is on; the line under the menu says what was set.

The lenses: Helios 44-2, Meyer Trioplan, Petzval, Takumar 50 f/1.4, an
uncoated 1930s lens, Anamorphic 2x, Jupiter-9 85, and Canon 50 f/0.95.
Each is a starting point. Every
section it wrote stays its own section afterwards, with its own switch and
reset, so the character is a place to begin rather than a look you are held
to. The aperture and focus are never written, and the flare dials answer
only the lights in the Depth Lighting rig: what to switch on to see each
signature is under Seeing the character below. Choosing another lens
first puts back whatever the previous one overwrote, and switches off a
section only that lens had switched on, so the photograph carries one
lens at a time and never a blend of two.

Much of the character lives in the depth tools, so it lands best on a
photograph whose depth plane has been computed; the sections ask for it as
they need it.

## Seeing the character

A freshly applied character can look quiet, because three of its
signatures each need one thing from the photograph first:

- **The bokeh** needs an open aperture. The apply never writes one (the
  aperture is the photograph's own decision), so while the aperture is
  zero the **Open aperture** chip shows under the menu: one click writes
  the lens's own wide-open aperture into Depth of Field and sets the
  focus from the depth plane, computing the plane first if the
  photograph has none (a one-time model download asks before fetching).
  If the plane was not there yet, the aperture still lands and the same
  chip reads **Focus at the plane's median** until a focus is set, by
  that click or by Set focus. Nothing is written behind your back.
- **The flare** needs a flaring light. The Lens Flare dials answer only
  lights in the Depth Lighting rig with flare on, so while no light
  flares the **Add a flaring light** chip shows: one click adds one
  light at the frame's brightest point with its flare on, building
  Depth Lighting first if the photograph has none. It does not relight
  the scene.
- **The bloom** needs highlights: Halation draws only where the
  photograph passes its threshold, so a frame with nothing bright enough
  shows no halo. Lower Halation's threshold, or pick a photograph with
  real highlights.

Each chip is one undo step of its own, separate from the apply's.

Open aperture, Focus at the plane's median, and Add a flaring light apply only while the photograph, take, and chosen character still match the click. Changing the target settings or closing this view cancels a pending answer. A newer click replaces an older pending read.

In the graph the depth arrives by wire, from the Depth Map node's depth output to this node's **depth** input, and asking for depth here adds the wire. With no wire the scene reads as flat, every depth the same, and a Develop section that is asking says NO DEPTH MAP. See [Depth Map](depth-map.md).
