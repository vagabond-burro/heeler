# Merges, panoramas, and baked photographs

Merges and panoramas keep recipes referring to their source frames. You can change that recipe and develop the result. Bake creates a separate photograph from the result you see.

## Panoramas

**Photo > Stitch to Panorama…** makes a panorama from the selected frames. It finds which frames overlap, solves how the camera was turned for each, and paints them onto one surface. A frame that overlaps nothing else is left out, and the console names it. The Pano panel changes the recipe afterwards: the surface it is projected on (Auto, Cylindrical, Spherical or Planar), **Match exposure** and **Straighten**.

### Lens correction

A wide lens bows straight lines, and the bow is strongest at the edges of the frame, which is where neighboring frames overlap. Uncorrected, wide frames line up in the middle of each overlap and drift apart toward its ends. With **Lens correction** on (the default), each frame's distortion is undone from its lens profile before the frames are matched and again as they are painted, so they line up across the whole overlap. The profile comes from the same lens database the Lens panel uses, matched to the lens and focal length each frame's metadata names.

The Pano panel says which profile was found, and for how many of the frames. When no profile is found, the frames stitch exactly as they would with the switch off. Turning **Lens correction** off stitches every frame uncorrected, as panoramas were stitched before.

### Seams

Where two frames overlap, each part of the overlap comes from one of them, and the join is blended so it does not show. The join runs where the two frames agree: through sky, grass or anything that stayed still, and around anything that moved between the shots. Someone walking through the overlap appears whole, in the place one frame caught them, or not at all; they are not cut in half or left as a faint double. When the frames agree everywhere the seam runs down the middle of the overlap, where each frame is at its sharpest.

## Bake to Image

Select one or more photographs, then choose **Photo > Bake to Image…** or use the thumbnail context menu. Bake works on ordinary photographs as well as merges and panoramas.

Bake renders the current edits at full resolution and creates a new file beside the original. For a merge or panorama it retains the established location beside the first source frame. The original and its recipe are untouched. A neutral merge recipe keeps the merged result; an edited recipe includes those edits too.

Choose a format:

- **DNG**, the default, keeps scene-linear values above white. It freezes the complete edit graph before display encoding, then opens with fresh controls and the tone profile bypassed so the look is not applied twice.
- **TIFF** stores 16-bit display pixels without compression loss; highlights above white clip.
- **JPEG** makes a smaller 8-bit display file; highlights above white clip.

Press **Bake** and the dialog closes; the bake runs under its own progress. When a merge has to be merged at full size first, its merge card shows (frames, time left and **Cancel merge**), then the bake's progress with its own **Cancel**. Canceling either one before the file is being written stops the bake without making a file; once it is being written, the bake finishes.

The new photograph appears in the catalog and folder, with no link group and no copied edits. You can start editing it again. Existing names are never overwritten: baking `IMG_1234.CR3` might create `IMG_1234.dng`, then `IMG_1234_2.dng`.

Bakes carry the source camera's EXIF, catalog stars and keywords, and an XMP origin record with the source filename and available capture time. A bake also marks itself as already rendered, in its XMP and its Software tag, so it opens with the Tone profile off; either mark is enough, so it still does after another program rewrites the file's metadata. Source's Reset puts the profile's values back and never switches it on. DNG also records OriginalRawFileName. Its Metadata panel shows **Baked from IMG_1234.CR3**, giving you a way back to the editable original. A merge or panorama inherits camera EXIF from its first member and names its recipe as the origin.

Bake uses the same full-resolution Model denoise helper as Export. It can take time and requires enough memory for the full render. It uses the same output license gate as Export.
