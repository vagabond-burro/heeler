# Demo photographs

Drop JPEG / PNG / WebP files here and the browser build's sample
session uses them as its library, one per thumbnail, in filename order
(cycling if there are fewer than thirteen). Empty, the session falls
back to the single bundled sample photo.

These are what the user guide's screenshots show, so they get committed
to the repository: use photographs you are comfortable publishing.

Guidelines that make the screenshots read well:

- 10 to 16 files; a mix of landscape and portrait orientation
- varied subjects and colors, so the grid reads as a library
- long edge around 1600 to 2000 px is plenty; RAW files will not work,
  because the browser build has no RAW decoder

Source files (RAW, oversized or metadata-carrying originals) go in the
`originals/` subfolder, which is gitignored: the folder's own glob reads
only its top level, so originals never reach the demo or the repo. The
committed `demo-*.jpg` files are canvas re-encoded copies, which strips
every byte of metadata, GPS included.

After adding files, re-run the affected screenshot scenes:

    node scripts/docshots.mjs

or by scene name for a subset (main-window, library-panel,
thumbnail-panel, viewport, expanded-catalog, workspace-graph,
workspace-canvas, relight-widget, finish-dodge-burn, finish-isolate).
