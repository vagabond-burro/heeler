# Changes from upstream

This is LibRaw 0.22.2 as released by LibRaw LLC, with the changes below
made by the Heeler project. Every change is marked with a `Heeler:`
comment in the source.

- `src/demosaic/misc_demosaic.cpp`, `pre_interpolate`: a half-size
  X-Trans develop finds its all-green half-size pixel (the one 2x2 block
  in nine with no red or blue site) from the CFA layout instead of from
  the pixel values. Upstream takes the first pixel in the top-left corner
  whose red and blue are both 0, and a dark, noisy corner can show an
  ordinary pixel that way: the wrong ninth of the image was then
  interpolated and the real all-green ninth kept no red or blue, which
  the color conversion turned into a green cast over the whole frame.
  Files whose phase upstream already found correctly develop exactly as
  before.
