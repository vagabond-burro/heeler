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

- `src/demosaic/xtrans_demosaic.cpp`, `xtrans_interpolate`: the full-size
  X-Trans demosaic keeps each tile's finished pixels in a separate
  buffer, copied back into the image once every tile is done, and shares
  the tile bands between threads (the machine's cores, up to four, set
  by `heeler_set_xtrans_threads`) when LibRaw is built without OpenMP.
  The tiles overlap by 16 pixels, and upstream each tile wrote its
  finished pixels back into the image that the next tile's margin read
  as sensor data (the green bounds and the copy a tile starts from), so
  the result depended on the order the tiles ran in, and with OpenMP on
  which thread got there first. Now every tile reads only the unmodified
  input, and the output is the same on any number of threads. It differs
  from upstream's only in pixels within the tile seams, by what those
  used to read from the tile before; on six samples from X-Trans I to V,
  about 1% of pixels, all of them on a seam.
