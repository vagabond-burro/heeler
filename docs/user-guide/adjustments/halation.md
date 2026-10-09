# Halation

Halation is the film's own glow: bright highlights bleeding a colored mist
into the dark around them, the way light scatters back through a film's base
and fogs the emulsion. Heeler draws it after Depth of Field and the Lens
Flare, in scene light, so the profile rolls the bloom into the highlights the
way it would have on film.

## Controls

- **Threshold** is the brightness a highlight must reach to bloom, in stops
  above middle gray. Lower it and dimmer lights join in.
- **Background gain** keeps the effect to high-contrast borders: halation is
  hard to see against a bright field, so the higher this is, the darker the
  surroundings must be for the bloom to show.
- **By depth** weights the bloom by distance on the depth plane, so far
  lights bloom more (or less) than near ones.
- **View isolated regions**, the eye in the section, shows only what will
  bloom, white on black, so the thresholds are tuned against exactly that.
- **Spread** is how far the light leaks; **Diffusion** runs the halo from a
  hard visible ring to a soft blended gradient.
- **Format** scales the spread the way the film gauge would have: 8mm and
  16mm are enlarged more for viewing, so their halation reads larger; 65mm
  reads tighter.
- **Hue** and **Saturation** set the glow's color; the red-orange of film by
  default, zero saturation for the white mist. **Blue compensation** keeps the
  bloom visible on blue highlights, like skies, that would neutralize it.
- **Strength** is the bloom's brightness and **Mix** how much of it shows.
- **Bloom** adds a wider, neutral glow around the same sources, the
  diffusion-filter look, with its own radius.

Halation on a perfectly clean digital frame can look pasted on; the Grain
section sits beside it for that reason, and the lens presets set both.

In the graph the depth arrives by wire, from the Depth Map node's depth output to this node's **depth** input, and asking for depth here adds the wire. With no wire the scene reads as flat, every depth the same, and a Develop section that is asking says NO DEPTH MAP. See [Depth Map](depth-map.md).
