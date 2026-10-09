# Spec: Camera Tethering (M6)

Status: VERIFIED on the DC-S5 (2026-08-26). Authorized by the
2026-08-23 Section 17 amendment ("Finish M5 and then move onto
M6... Camera controls for exposure, white balance, shutter control,
camera focus, naming convention, destination (folder and
collections)."). The engineering spec's exclusion of tethered capture
is lifted; the no-GPL rule stands for every transport dependency.

2026-08-26: the Camera half is split into phases by the product decision,
replacing the old 6.3/6.4 two-part division. Phase 1 is connection,
diagnostics, and still capture. Phase 2 is exposure control (shutter,
aperture, ISO, white balance). Phase 3 is live view. Phase 4 is focus
control. All four are verified on the DC-S5. No dead controls ship
from any phase: the panel says what is coming in words and renders
nothing for it.

2026-08-26, the product decision on the milestone: **tethering does not ship at
all, not even as an experimental preview.** "It's not an easy feature
and has been left in an indefinite experimental state... Since it's
hard to verify numerous cameras, I don't think making it available
even as an experimental feature is a good idea for the commercial
release." One Panasonic body answers; nobody can buy a copy and find
out theirs does not. So the Experimental features preference itself is
now a development build's control (`previewBuild()` in
apps/heeler-app/src/features.ts, which reads Vite's DEV flag): in a
shipped build the toggle is not in Preferences, not in its search, and
the Tether tab has no seat whatever the stored preference says. The
preference is never rewritten, so a development build picks up
whichever way the user last set it. The user-facing connection guide
moved out of docs/user (the folder the Help viewer ships) to
docs/tethering-connection.md for the same reason.

The gate is one function and one call site. On the day enough bodies
are proven, `previewBuild()` returns true, the toggle comes back, and
the guide moves back into docs/user.

## The shape

Tethering is a TAB in the right panel (the product decision), not a dialog: a
shoot is a session, and a session lives where the work lives. The tab
has two halves:

1. **Session** (watched folder, shipped 2026-08-23, no camera code):
   where images come from and where they land.
   - Hot folder: the folder a camera or vendor tether app writes into.
   - Destination: optional folder the incoming file is MOVED to before
     import (the standard ingest pattern; empty = leave in place).
   - Naming convention: a pattern applied on ingest, tokens
     `{name}` (original stem), `{seq}` (session counter, 4 digits),
     `{date}` (YYYYMMDD). Empty = keep the original name.
   - Collection: optional; every ingested image is added to it.
   - Start / Stop, a status line (session count, last file in), and
     auto-advance: the newest frame becomes the active image the
     moment it lands, which is the whole point of tethering.
   - Pairs with the media server's existing /live view: the client on
     a tablet sees each frame as it arrives; nothing new to build.

2. **Camera** (direct capture, three phases): the controls the owner listed.
   - Phase 1 (this branch): enumeration and diagnostics first, so
     "not detected" and "detected but not usable" read differently in
     the panel; then the PTP session, device info and property set on
     the record, and still capture landing through the SAME import
     path as the folder watch (naming, destination, collection,
     auto-advance, and the settle logic that refuses half-written
     files). Nothing is removed from the camera's card, ever.
   - Phase 2: exposure control, against the property set phase 1 put
     in the diagnostic report.
   - Phase 3: live view, when the transport provides frames (spec
     below, written against libgphoto2's Panasonic preview path).
   No dead controls ship: a phase renders only what its transport
   proves.

## 6.1 Transport and licensing spike (verdict)

Researched 2026-08-23; licenses re-verified against crates.io on
2026-08-26 when the dependency was added.

| Option | License | Windows | macOS | Verdict |
|---|---|---|---|---|
| libgphoto2 (+ gphoto/gphoto2-sys crates) | LGPL-2.1 (bindings MIT) | weak/unofficial | good | Allowed by the no-GPL rule (dynamic link), but the Windows story disqualifies it as the primary transport. Possible Linux/macOS fallback. |
| Pure-Rust PTP over `nusb` | nusb Apache-2.0 OR MIT (crates.io 2026-08-26); the PTP layer is our own code over PIMA 15740 | yes | yes | **The chosen base.** The crates.io `ptp` lineage is MIT but unmaintained since 2017 and rides the C libusb, so the protocol layer is written in-house (src-tauri/src/ptp.rs): no C dependencies, no LGPL. |
| Canon EDSDK | Proprietary developer agreement; object-code redistribution with the app is licensed, no fee | yes | yes | Candidate for the Canon family in phase 3 (live view quality). Requires signing their agreement; keep behind a feature flag so a build without it still ships. |
| Sony Camera Remote SDK | Proprietary, same shape as Canon's | yes | yes | Same posture as EDSDK, for the Sony family. |
| Nikon / Panasonic | Nikon SDK by application; Panasonic (the owner's own glass) speaks PTP and Lumix-flavored PTP/IP over Wi-Fi | n/a | n/a | Panasonic first among the PTP targets since the owner can test it; PTP/IP is the same protocol over TCP and reuses the pure-Rust stack. |

Decision: ship the watched folder with zero camera code; build direct
capture on pure-Rust PTP over `nusb` (Apache-2.0 OR MIT), Panasonic
first because the test hardware is on the owner's desk; treat vendor SDKs as
per-family accelerators for phase 3, each behind its own feature flag
and developer agreement, never a hard dependency.

## Panasonic caveats (investigated in phase 1, not assumed)

- Lumix bodies expose several USB modes (mass storage, PTP, PC tether /
  PC Remote), and the mode chosen ON THE BODY decides whether a class-6
  interface appears at all. The scan classifies what it sees: a known
  camera presenting only mass storage gets a verdict and the remedy
  (switch the USB mode on the body) rather than silence.
- Remote capture may be absent from the operation set until the right
  mode is active; when InitiateCapture is not listed, the app says so
  and names the mode to pick. Panasonic tether bodies are the known
  exception, confirmed against libgphoto2's ptp.h and library.c on
  2026-08-26: a body reporting vendor extension 0x1C (the DC-S5 in
  PC(Tether) mode, USB product 0x2382, is one) hides its capture
  operation from the list. Remote release is vendor operation 0x9404
  with parameter 0x03000011, the frame announces itself with vendor
  events 0xC108 (card) / 0xC109 (SDRAM), and mid-capture event 0xC101
  expects a 0x9401 reply. libgphoto2 hard-codes this family rather
  than trusting the reported list; Heeler does the same.
- macOS claims cameras for its own image-capture daemon; an open or
  claim failure on macOS comes with the remedy (quit Photos and Image
  Capture) rather than a bare error.
- The known-body list is for diagnostics only: an unknown vendor with a
  PTP interface is still a candidate.

## 6.2 Watched-folder session (v1, shipped 2026-08-23)

Backend: a poll-based session (no filesystem-watcher dependency; a
2-second poll of one directory is nothing, and stability is what
matters). A file counts as ARRIVED when its size has been stable
across two polls, which is how you avoid importing half a RAW the
camera is still writing. Ingest = optional move+rename per the naming
pattern, then the same catalog registration `scan_folder` does (the
hidden and trashed rules apply to tethered frames like any other),
then optional collection membership. The session keeps the seen-set,
so restarting the poll never re-imports.

Frontend: the Tether tab (Session half), plus auto-advance wired to
the ribbon's existing selection machinery. Session state is view
state: no undo, not persisted into edits.

Naming collisions: a rename that would overwrite refuses and falls
back to the original name with a logged note; nothing is ever
overwritten (the file-safety rule applies to arrivals too).

## Direct capture phase 1 (this branch, hardware-verified by the owner)

The camera half shares the session's import path: `tether_settle` and
the `register_arrivals` half of `tether_poll` are the only way a frame
enters the catalog, whether the folder watch or the PTP session found
it. The frame is written next to its target and renamed, never
overwritten, and the object on the camera's card is only ever read.

Diagnostics are a feature, not a side effect: every enumeration and
session step logs to heeler-console.log, and the panel's Copy
Diagnostics button hands the owner (or a stranger with a body nobody owns)
the scan report plus the connected body's operation, event, and
property sets.

What the 2026-08-26 hardware runs on the owner's DC-S5 proved, beyond the
happy path:

- A body shooting RAW+JPG announces each file separately. The capture
  call fetches the first announced frame; the card watch (the same
  poll that lands shots fired on the body) sweeps the rest. Both land
  as ordinary arrivals. Whether a RAW+JPG pair should read as one
  catalog item with two files is a real DAM question for a later
  phase; phase 1 deliberately imports both and pairs nothing.
- The body announces a newly created DCIM folder over ObjectAdded
  ahead of the frame. Every arrival path checks the announced handle's
  object format and skips associations; fetching a folder stalls the
  bulk pipe (seen live), and a stall is now answered with a halt clear
  so the session survives a failed fetch.

## Direct capture phase 2 (exposure control): built 2026-08-26, awaiting the owner's UI run

Spec written 2026-08-26 against libgphoto2's ptp.h, ptp.c, and
config.c read the same day, then settled by the DC-S5's own descriptor
dump (`panasonic_property_descriptors`, an ignored hardware test that
never sets a value). What the dump proved: ISO answers with 29 values
(0xFFFFFFFF is auto, the rest plain integers); shutter speed answers
with 59 (0xFFFFFFFF bulb, bit 31 marking whole seconds, 60 s down to
1/8000); aperture answers in 2-byte values of f-number times ten
(current 80 = f/8.0, list 220 down to 28 = f/22 to f/2.8); and white
balance answers with the named table plus preset codes 0x800B up. The
standing rules hold: no dead controls, the card is never written, and
the body is the source of truth for every value the panel shows.

### The property channel

Standard PTP device properties are nearly absent on the DC-S5 (the
phase 1 report lists one: BatteryLevel). Panasonic's real settings
live behind 32-bit vendor property codes over three operations:

- 0x9402 GetProperty(propcode): the response data is a u32 header, a
  u32 value size, then the current value (2 or 4 bytes).
- 0x9108 ListProperty(propcode): the descriptor, meaning the current
  value AND the list of values the body accepts right now. The list is
  what a control offers; a body in an auto mode answers a different
  list than in M, which is how the panel stays honest without
  hard-coding modes.
- 0x9403 SetProperty(propcode) with a data phase: propcode u32, value
  size u32, then the value bytes at offset 8, mirroring the GetProperty
  answer. The body reads the value at that fixed offset; a tighter
  packing lands it early and reads as zero (proven live on the DC-S5:
  ISO and white balance jumped to auto, shutter clamped to 1 s).
  Writes go to the _Param codes, reads to the base codes.

### The exposure triangle

| Setting | Read code | Write code | Encoding |
|---|---|---|---|
| ISO | 0x02000020 | 0x02000021 | plain integer, 0xFFFFFFFF is auto; allowed values from 0x9108 (dump-proven) |
| Shutter speed | 0x02000030 | 0x02000031 | value/1000 is 1/x seconds; bit 0x80000000 set means value/1000 whole seconds; 0xFFFFFFFF is bulb (dump-proven) |
| Aperture | 0x02000040 | 0x02000041 | f-number times ten, 2 bytes (dump-proven: current 80 = f/8.0, list 220..28 = f/22..f/2.8); display confirmation is part of the UI run |

White balance (the 0x02000050 family) shipped in the group: the dump
confirmed the family answers on the S5, with the named table from
libgphoto2 (auto 0x0002, daylight 0x0004, tungsten 0x0006, flash
0x0007, cloudy 0x8008) and preset codes 0x800B upward.

### UI shape

- The Tether tab's camera section gains an exposure group, visible
  only while a body is connected and capture-capable. Each control is
  a label, the body's current value, and choices taken from the body's
  own descriptor list; choosing sends the set and then re-reads.
- A control whose read fails says so in words ("the body did not
  answer for aperture") instead of showing a frozen fake value. If no
  exposure property answers at all, the group says that once and
  renders nothing else.
- BatteryLevel, the one standard property phase 1 proved readable,
  joins the group as a read-only line.

### Honesty and safety

- SetProperty changes camera settings only; the card is still never
  written or deleted.
- A set can be refused or clamped (mode dial turned, lens off, auto
  mode). A failed set surfaces the body's answer in the console and
  the control re-reads; the panel follows the body, never the other
  way around.
- Whether a setting survives power-off is the body's business; the
  panel never claims persistence.

### Verification protocol (the owner + DC-S5, same shape as phase 1)

1. DONE 2026-08-26: the ignored hardware test printed each property's
   descriptor raw; the paste-back settled all four encodings.
2. UI run: change ISO, shutter, aperture from the panel and take one
   shot per change; the EXIF of the landed frames is the ground truth
   that the sets took effect.
3. Failure drill: turn the mode dial to an auto mode and confirm the
   controls follow the body's new list instead of lying.

Out of scope, named so nobody rediscovers them: bulb mode (0x9404
with parameters 0x03000012 / 0x03000013), movie record control
(0x940C), and the camera-side parts of focus stacking. Live view is
phase 3 and focus drive phase 4, both specced below.

## Direct capture phase 3 (live view)

Spec written 2026-08-26 against libgphoto2's ptp.h, ptp.c, and
library.c (camera_capture_preview's Panasonic branch) read the same
day; hardware-verified by the owner's DC-S5 the same evening
(panasonic_live_view_frames): the wire protocol below works as written,
30 frames in 1.01 s, every one a valid JPEG of 27244..27362 bytes. Frame
sizes repeat in threes, so the body produces a unique frame about every
100 ms and 0x9706 answers with the latest: a real ~10 fps, pumped at
~30 requests/s.

### The wire protocol, as libgphoto2 speaks it

- Start: 0x9412 with parameter 0x0D000010; stop: 0x9412 with
  0x0D000011. After start, the body needs about 100 ms before frames
  flow.
- Frames: 0x9706 (LiveviewImage), no parameters, data in. The payload
  is a header (about 128 bytes) followed by a JPEG; the JPEG is found
  by scanning for the SOI marker 0xFFD8 and cut at EOI 0xFFD9. A body
  mid-work answers DeviceBusy; libgphoto2 waits 40 ms and retries.
- Frame size and rate knobs exist (0x9414 / 0x9415, Get/Set
  LiveViewParameters) but are optional: phase 3 takes the body's
  default frame first and touches parameters only if the owner's run says the
  default is unusable.

### UI shape

- The Tether tab's camera section gains a LIVE VIEW toggle beside
  CAPTURE, visible only while connected. On, the panel pumps frames
  and shows them; off, the body gets the stop parameter. The toggle
  goes off by itself on disconnect, on the experimental gate closing,
  and when a frame pump error repeats: a live view that lies by
  freezing is worse than none, so a stalled pump says so and stops.
- The frame rate is displayed as measured, not as promised. USB2
  bodies land in single digits; that is the transport, not a bug.
- Live view shares the session with capture and the card watch; every
  command is serialized through the session lock already. What the S5
  does when CAPTURE fires mid-live-view is unknown and part of the
  verification run; if the body refuses or wedges, phase 3 pauses the
  pump around capture rather than pretending the combination works.
- The main viewer is untouched: phase 3's frame lives in the camera
  section. Promoting it to the viewer (focus peaking, zoom, click-to
  focus) is its own phase with its own spec.

### Verification protocol (the owner + DC-S5)

1. An ignored hardware test starts live view, pulls 30 frames, checks
   each for SOI/EOI, and prints frame sizes and the achieved rate.
   The paste-back settles the frame format before any UI ships.
2. UI run: toggle on, pan the camera, confirm motion; toggle off and
   confirm the body returns to normal shooting (half-press works on
   the camera itself).
3. Interaction drill: CAPTURE mid-live-view, then a shot fired on the
   body mid-live-view; both frames must land and the pump must
   recover or say why it stopped.

Out of scope, named so nobody rediscovers them: live view parameter
tuning (0x9414 / 0x9415), the 0x9705 live view control op, click-to
focus and focus peaking, and any recording path.

## Direct capture phase 4 (focus control): VERIFIED on the DC-S5

Written 2026-08-26 against libgphoto2's ptp.h, ptp.c, and config.c
read the same day; hardware-verified by the owner the same evening. the owner's ask:
focus drive in both directions with several step sizes, plus an
autofocus trigger, laid out as [<<<][<<][<] [>][>>][>>>] and
[AUTO FOCUS]. What the body actually honors settled smaller and, in
one place, better:

- The UI run passed: the row drives both directions at both speeds,
  directions match the buttons, and the first-drive refusal after
  stream start is retried inside the backend so the UI never sees it.
- A body in AF refuses every drive; the error says to switch to MF
  rather than reading like a bug.
- The separate autofocus trigger is settled and shipped: probe run 5
  (2026-08-26, stream on, body in AF) found the path in the RecCtrlAFAE
  family ptp.h declares but gphoto never calls. 0x9405 with the AF
  one-shot code 0x03000024 as its parameter was accepted, the lens
  swept (the owner, watching), and the body reported the result as event
  0xC104 on the interrupt pipe. Every other path in the family
  refused: the descriptor is not listable, the property channel
  answers invalid parameter, and the command base answers general
  error. The AUTO FOCUS button ships between the drive halves (same
  stream gate), and "AF on capture" is a panel toggle: one sweep
  before the release, with a refusal logged rather than fatal, because
  an MF shot is still a shot the shooter meant to take.

### The wire protocol, as libgphoto2 speaks it

- Manual focus drive: 0x9416 (ManualFocusDrive), data-out, payload =
  control code 0x03010011 (u32), a type word of 2 (u32), the mode
  (u16 at offset 8); the command parameter is the control code too.
  gphoto's confirmed modes: 0 stop, 1 far fast, 2 far slow, 3 near
  slow, 4 near fast. the owner wants three levels per direction; whether the
  body honors finer or coarser steps beyond these four is exactly what
  the probe run settles.
- Autofocus: 0x9405 ("Rec Ctrl AF AE" per ptp.h). gphoto declares the
  opcode but never calls it, so the parameter is unproven; the probe
  tries the control codes the release (0x03000011) and focus
  (0x03010011) channels use.
- Focus drive moves the lens and touches nothing else. The body must
  be in a mode where a focus drive is meaningful (MF on the body or
  lens); what the S5 does in AF modes is part of the run.

### Verification protocol (the owner + DC-S5)

1. The ignored hardware test panasonic_focus_drive walks modes
   1..8 with a pause between each (watch the lens; note which modes
   move it and how far), then tries 0x9405 with both candidate
   parameters (note whether the body runs an AF sweep).
   - Run 1 (2026-08-26, no stream): every mode answered 0x201D
     (invalid parameter), both AF codes answered general error. A
     refusal that uniform is a missing context: the maker's own tether
     app drives focus over the live view stream.
   - Run 2 (2026-08-26, stream on, MF): modes 1, 3, 4 accepted; 2,
     5, 6, 7, 8 refused; AF refused again. the owner saw near movement only,
     which is positional: a lens at the far stop accepts a far drive
     and shows nothing.
   - Run 3 (2026-08-26, stream on, MF, lens at mid-range): every mode
     1..4 accepted, both directions moved (6 ft up toward infinity and
     down to 4.5 ft). The one "invalid parameter" on the first drive
     after stream start is a transient; one retry clears it and the
     backend does that retry. Settled table: 1 = farther, big step;
     2 = farther, small; 3 = closer, small; 4 = closer, big. The body
     has two speeds per direction, not three (5..8 refused), and AF
     over 0x9405 is still unproven (general error, both runs).
   - Run 4 (2026-08-26, stream on, body in AF): both 0x9405 control
     codes refused with general error even in AF. 0x9405 is settled as
     refused on the DC-S5 in every context probed; it is not the
     standalone AF trigger.
   - Run 5 (2026-08-26, stream on, body in AF): SETTLED. The family
     descriptor is not listable, both property-channel writes answered
     invalid parameter, and 0x9405 with the command base answered
     general error, but 0x9405 with the AF one-shot code 0x03000024
     was accepted, the lens visibly swept, and the body answered with
     event 0xC104 (param 0x08000010) on the interrupt pipe. The AUTO
     FOCUS button and the AF-on-capture toggle ship on this result.
2. The step table above is what the UI ships: [<<][<] [>][>>], left
   closer, right farther, one chevron small, two big, scaled up for
   the shoot.
3. UI run: live view on, drive focus both directions, confirm the
   frame shows the focus moving and the directions match the buttons.

Out of scope: click-to-focus (needs the live view frame's coordinate
mapping), focus stacking, focus bracketing, and focus peaking (a
viewer-side feature, not a camera control).

## Family readiness (groundwork laid 2026-08-26, no hardware beyond the DC-S5)

How scalable is this to other cameras? Manufacturers do not publish
tether protocol documentation; the authoritative public source is
libgphoto2's ptp.h and ptp.c, reverse engineered over two decades, and
every vendor constant in `ptp.rs` is transcribed from there. The stack
splits into what every family shares and what each family owns:

| Layer | Shared or per family |
| --- | --- |
| USB transport, session, container coding | Shared: PIMA 15740 standard, every family |
| Card watch and import path | Shared: standard GetObjectHandles plus ObjectAdded, with the Panasonic vendor events as the odd one out |
| Capture | Per family: Panasonic 0x9404 (verified on the DC-S5); Canon EOS remote-mode sequence 0x9114 then 0x910F (tabled); Nikon 0x90C0 / 0x9207, or standard InitiateCapture on bodies that list it (tabled); Fujifilm thin coverage (tabled); Sony SDIO handshake first (known hard) |
| Exposure properties | Per family: Panasonic vendor channel 0x9402/0x9108/0x9403 (verified); Canon SetDevicePropValueEx 0x9110, Nikon standard device properties, both tabled |
| Live view | Per family: Panasonic 0x9412/0x9706 (verified); Canon viewfinder ops 0x9151/0x9153, Nikon 0x9201/0x9203, both tabled |
| Focus drive | Per family: Panasonic 0x9416 (verified); Canon DriveLens 0x9155 / DoAf 0x9154, Nikon MfDrive 0x9204 / AfDrive 0x90C1, both tabled |

What shipped without hardware, and only this:

- Detection names the family in the scan report and states readiness
  honestly (`Panasonic: ... verified on the DC-S5`, `Canon: detected
  only; ... unwired until a body verifies it`, and so on).
- The connect-time note when capture is absent names the family and
  its remedy (Lumix: pick PC tether mode) or its unwired status
  (Canon EOS, Nikon, Fujifilm, Sony), instead of Lumix advice for
  everyone.
- The device report reads a connected body's operation list against
  the family's table (the vendor code space overlaps: 0x9102 is a
  Panasonic session verb and a Canon EOS storage verb).
- The vendor operation tables sit in `ptp.rs` next to the Panasonic
  one, each constant transcribed from libgphoto2 and marked unverified.

Nothing is wired for these families: `can_capture` stays standard
InitiateCapture or Panasonic, so a body Heeler cannot drive gets no
capture button, per the no-dead-controls rule. A Nikon body that lists
standard InitiateCapture does get the shared capture path, which is
the one piece likely to work on first contact. Sony stays the hard
case: the SDIO session is a multi-phase handshake (0x9201 in stages,
then 0x9210) that must be negotiated before any property or capture
operation answers, which is why gphoto's Sony path is its own world.
Bringing up any of these families is a bench session with a body, run
the same way the DC-S5 was: scan, connect, dump the device report,
probe one operation at a time against the tabled constants.

### Platform readiness

The tether stack is cross-platform by construction: nusb (pure Rust,
Apache-2.0 OR MIT) is the transport on all three OSes, and everything
above it (containers, sessions, vendor operations, the import path) is
OS-neutral. What differs per OS is who else wants the camera:

- **macOS (verified on the DC-S5):** the PTP daemon (ptpcamerad,
  mscamerad-xpc) claims the body on connect; the app kills it and
  retries automatically.
- **Linux (expected to work, untested):** usbfs needs no driver swap,
  but the device node must be user-writable (a udev rule; the scan
  report and the open-error remedy both say so). Desktops that
  auto-mount cameras through gvfs-gphoto2 can hold the body the way
  ptpcamerad does on macOS; nothing kills those yet.
- **Windows (needs one setup step):** nusb speaks WinUSB, and a camera
  binds to Microsoft's PTP class driver, so the scan sees the body but
  the claim is refused until WinUSB is installed for that camera with
  Zadig. The binding is per camera and persistent. The scan report and
  the claim-failure error both carry this remedy; it is the one
  platform where the first connect cannot succeed without user action
  outside the app.

  Where exactly it fails, read out of nusb 0.2.7's Windows backend on
  2026-08-26 (source, not a bench run): enumeration reads the config
  descriptor from the hub port, so the interface class is visible no
  matter which driver is bound and the body still classifies as
  `PtpCapable` with a live CONNECT chip. `claim_interface` then looks
  up the bound driver by devinst and returns `ErrorKind::Unsupported`,
  "incompatible driver is installed for this device", for anything
  that is not `winusb` or `usbccgp`. So the whole Windows story lands
  on the claim-failure remedy string, which is why that string names
  the user doc.

### Why no driver package (decided 2026-08-26)

Microsoft documents a supported way to ship this: an INF that pulls in
the in-box `winusb.sys` with `Include=winusb.inf, Needs=WINUSB.NT`.
Reviewed and declined. It is not a licensing problem, and worth
recording that it is not, so the question stays answered: no Microsoft
binary is redistributed (winusb.sys is already on the machine), there
is no royalty, and commercial device vendors are the intended users of
that mechanism. The reasons it still loses:

- **Signing.** A driver package needs a Microsoft-signed catalog to
  install on x64. That is a Partner Center hardware account plus an EV
  certificate, and every INF revision goes back through submission.
  Different, higher bar than the installer signing already budgeted.
- **It hijacks the device.** The binding is by hardware ID and
  persistent, so Heeler's installer would silently take cameras away
  from the file browser, the system photo importer, and the vendor's own tether app, for models we
  guessed the user owns. That is a support and reputation liability the
  product does not need.
- **It contradicts the scan's own principle.** An INF covers a tabled
  list of VID/PIDs; this stack deliberately treats an unknown vendor
  with a class-6 interface as a candidate. Every new body would mean an
  INF entry, a resubmission, and an app update.
- **It closes the Store door.** MSIX packages cannot install drivers,
  so it rules out the Microsoft Store channel, which Heeler ships
  through.

The escape worth spiking later, before anyone reopens the driver
question: Windows exposes MTP vendor pass-through through WPD, via
`IPortableDevice::SendCommand` with the `WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_*`
family. If that surface carries arbitrary opcodes, the PTP layer here
keeps working through the in-box driver with no INF, no signing, and no
hijack. Unverified, and the parts to prove out are vendor event
delivery (0xC108 / 0xC109, which live view depends on) and bulk
throughput. PTP/IP over Wi-Fi sidesteps the whole question for Lumix,
and the vendor SDKs bring their own Windows plumbing.

The shipped answer meanwhile is documentation:
[docs/tethering-connection.md](tethering-connection.md) walks the Zadig pass,
states the trade in plain words, and gives the Device Manager undo.

## Tier note

Session tethering ships in the current build behind the experimental
gate. Direct capture and remote control are natural pro-tier
candidates; they get their flag when M9 wires the tier surfaces, like
every other pro feature.

Sources for the licensing table: the gPhoto project pages and Free
Software Directory (LGPL, platform support), crates.io for `nusb`
(Apache-2.0 OR MIT, verified 2026-08-26) and `ptp` / `gphoto` /
`gphoto2-sys` licenses, Canon's EDSDK developer agreement, Sony's
Camera Remote SDK license agreement page.
