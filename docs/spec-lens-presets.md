# User lens presets

Status: **BUILT** (2026-08-23, same day as the design; the owner answered the
open question: Perspective stays out). The checklist below landed as
written: load/save commands in the desktop crate, `lenspresets.ts`
holds the parameter contract (LENS_NEUTRAL is the single list capture
and apply both walk), the Lens section row sits under the profile
line, and the four contract tests pass. the owner's ask, from the lens-profile work:
much of his own glass is vintage and unchipped. Those lenses write no
EXIF name, so the lensfun pipeline (docs/spec-lens-profiles.md) can
never serve them, by design. The manual sliders are their path, and
today that path means re-dialing the same corrections on every photo.
A preset is that dial-in, named and kept.

## What a preset is

A named snapshot of the COMPLETE Lens Correction parameter state:

- the manual sliders: distortion, ca_red, ca_blue, vignette,
  vignette_mid;
- the profile parameters: dist_model, dist_a/b/c, dist_scale, the six
  tca_* terms, the three vig_k* terms.

Full state, not a diff. Two consequences, both wanted:

1. Applying a preset writes EVERY parameter, neutral where the preset
   is neutral: the same no-leftovers rule the profile Apply follows. A
   photo can never inherit half of one lens and half of another.
2. A lensfun-applied state is saveable too. Apply the XF50 profile,
   save "XF50 wide open", and the evaluated coefficients are now a
   one-click preset on any body, including one whose file lost its
   EXIF to an adapter.

A preset is STATIC. It does not know focal length or aperture, because
the lenses it exists for never say. Vignetting in particular changes
as a lens stops down; the name field is where that lives, and saving
"Helios 44-2 f/2" and "Helios 44-2 f/8" as two presets is the intended
use, not a workaround. No modeling, no interpolation, no pretending to
data we do not have.

## Storage

The export-preset pattern, exactly: a JSON array under a catalog meta
key (`lens_presets`), read and written whole through a load/save
command pair. Presets survive a reinstall the same way ratings and
export presets do, and they are per-user, not per-photo: the photo
only ever holds ordinary node parameters, so a graph renders
identically on a machine that has never seen the preset list.

Shape: `[{ id, name, params: {…numbers…}, text: { dist_model } }]`.
Unknown keys in a stored preset are dropped on apply (a later version
may retire a parameter); missing keys apply as neutral. No starter
presets: unlike export, there is no preset everyone ends up making.

## UI

One row in the Lens section, under the profile line, matching its
sizing: a preset select and a SAVE chip.

- **Select a preset**: applies it, one `set_params` command (the
  mixed-kind form built for profile Apply), so it is one undo step and
  one history entry named for the preset. The console logs what
  applied, same voice as the profile line.
- **SAVE**: captures the active photo's Lens Correction state under a
  typed name. Saving under an existing name overwrites that preset
  (that is what the name means); otherwise it appends.
- **Delete**: available beside the select (the export presets' own
  management affordance is the pattern to follow). Deleting a preset
  never touches photos: applied parameters are already ordinary node
  state.

No auto-apply and no matching. These lenses are invisible to metadata,
so applying is always a deliberate click. If a body writes a generic
lens name for adapted glass (the owner's cameras write NO-LENS), the profile
line already reports honestly and stays out of the way.

## Provenance (added after the owner's first session with it)

Applying a preset stamps the node with a `lens_preset` text parameter:
the preset's name, declared in the node spec but never read by the
engine. The Profile line shows "Profile: (name) (preset)" whenever it
is set, so a photo revisited days later says where its lens state came
from. A lensfun profile apply clears the stamp (the database
supersedes the hand-dialed state); resetting the image clears it with
everything else; capturing a new preset does NOT copy it (a preset
records corrections, not the name of an older preset). The dropdown
itself stays stateless: it is an action picker, and the stamp is the
display of record.

## Non-goals

- Not a general node-preset system. Scoped to `heeler.lens_correct`;
  the recipes/group machinery is the general reuse story, and growing
  a second one here would be two answers to one question.
- No sharing/import/export in this pass. The JSON blob makes that
  cheap later if testers ask.
- No per-focal curves for vintage zooms. A zoom preset captures one
  focal length; again the name carries it. Vintage zooms are rare in
  practice and their owners know what they are doing.

## Build checklist (one phase; it is small)

1. Desktop: `load_lens_presets` / `save_lens_presets` commands on the
   catalog meta key, mirroring the export pair.
2. Frontend: preset list load on boot beside the export presets;
   `lenspresets.ts` with the type, sanitize-on-apply (drop unknown
   keys, fill neutral), and capture-from-node.
3. UI: the Lens section row (select + SAVE + delete), sized like the
   profile line's chip.
4. Tests: round-trip through the JSON shape; apply writes all
   parameters and is one undo step (extends the existing set_params
   test); capture-then-apply is the identity on the node; unknown
   stored keys are dropped, missing keys neutralized.

## Open question for answered

Should a preset also capture the Perspective node? No (2026-08-23):
keystone is a per-photo composition fact, not a lens fact.
