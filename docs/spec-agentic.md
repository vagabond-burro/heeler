# Spec: the assistant

Rewritten 2026-09-28 around the simple version the owner chose, after the
"Agentic Integration" request and the conversation that followed it.
The first spec (2026-08-16) planned Help, a natural-language network
builder and generative cleanup; the owner backlogged the agent work on
2026-08-25 to think
about what agentic and AI should mean in Heeler. This is the answer.

## In one screen

- **What it is:** a knowledgeable assistant beside the graph (the owner's
  words). It answers Help questions, explains and debugs the graph from
  measurements, finds photographs, and proposes changes the user
  approves.
- **What it never does:** change the picture's content. No pixels are
  added, removed or generated.
- **Where the model runs:** on the user's own machine or another
  computer of their home network, in LM Studio or a similar local
  server. Nothing the assistant reads leaves the home network.
- **How it sees:** numbers Heeler measures, plus Florence-2, a small
  local vision model Heeler downloads the way it downloads the depth
  model.
- **Which models:** a tested list built into Heeler; any other model
  works after a one-time acknowledgment that it is the user's choice
  and responsibility.
- **Legal:** it fits the EULA and privacy policy as they stand. No
  agreement change is needed for this version.
- **Tier:** free for questions; anything that changes the edit (a
  proposal) stays Pro, enforced by the reducer's tier gate.

## What AI means in Heeler

Heeler has two kinds of AI:

1. **Models that serve the photograph:** Depth Anything, SCUNet,
   MobileSAM, BiRefNet, LaMa, and now Florence-2. Local, downloaded on
   request, run through ONNX Runtime. They measure or separate what is in
   the picture. They are instruments.
2. **The assistant:** it reads the graph, the catalog and the user guide,
   and proposes actions the user could take with the same controls.

The rule over both: **the photograph stays the photographer's.** The
assistant explains, finds, measures and proposes. It never makes an
aesthetic decision on its own authority, and never makes something that
was not in the frame. (The product spec's exclusion of "generative fill
or any AI pixel synthesis" stands; the first spec's generative cleanup
is retired.)

## The same hands

The assistant acts only through the bridge (spec-python-api.md), the
command bus the UI uses. Every action is validated as the UI's would be,
refused with the same worded reasons, visible in the graph, and in the
user's own undo history. It cannot do anything the user could not, and
it performs no file operations on the operating system.

## Local only

"I am good with the local endpoints only for right now. I will
intentionally stall on cloud endpoints for services like chatgpt or
gemini."

- The assistant talks to one OpenAI-compatible server (LM Studio,
  Ollama, llama.cpp). Heeler runs the conversation and decides what the
  model may do; Heeler never launches another program.
- The server must be on the user's own computer or its home network,
  judged on the address the name resolves to, at every connection, never
  on the name or the port (a `.local` name counts for nothing by
  itself):
  - `localhost`, a loopback address (127.0.0.0/8, ::1), or one of this
    computer's own network addresses;
  - another computer at home: IPv4 home ranges (192.168.0.0/16,
    10.0.0.0/8, 172.16.0.0/12) and self-assigned 169.254.0.0/16; IPv6
    link-local (fe80::/10) and unique local (fc00::/7); and an IPv6
    global address only when it shares this computer's own /64 prefix.
    That last rule matters: `canyonlands.local` resolves to global IPv6
    addresses (`2600:1700:...`) that the provider hands every home
    device, so "private addresses only" would refuse the owner's server, and a
    loose check would let internet hosts in.
  Anything else, the internet included, is refused with a worded reason,
  and a name with one refused address is refused as a whole.
- **Home network on in every build** (2026-09-29: "add the sentence
  and turn on home network"; "most people are going to run a home
  server"). The EULA and Terms need no change (section 7 of each already
  covers third-party services and sending on the local network); the
  privacy policy gained its Assistant paragraph: "If you turn on the
  optional assistant, Heeler sends your questions and information about
  your edits only to a model server you choose on your own computer or
  local network. Nothing is sent to Vagabond Burro."
- **Heeler connects to the exact address it checked**, never to the name
  again. The name is looked up once per connection, the address is
  checked, and the connection is opened to that address. A second
  lookup could answer differently from the first (DNS rebinding), so a
  name that is redirected to an internet server, before or during a
  connection, is refused rather than followed.
- What lies beyond the checked address is outside what Heeler can see:
  a machine on the user's network that forwards traffic onward, or a
  compromised network impersonating the server. Heeler sends only to the
  server the user chose, at an address it has verified; what that
  server does next is its owner's doing (EULA section 7), and an attack
  on the user's network is not something Heeler causes. The safeguards
  Heeler takes itself (off by default, the recorded
  disclaimer, the address check at every connection) are what it
  answers for.

## How it sees the picture

1. **Numbers (always).** A picture report Heeler computes, the same
   quantities the Spectrums show: the tones in EV and clipping at each
   end; the color of shadows, midtones and highlights; a white balance
   estimate; a coarse grid (for example 8 by 8) of mean color and
   brightness, which says "the top third is bright and blue" without
   being a recognizable picture; the near plane against the far plane
   from the depth map; the capture time and, from GPS, the sun's
   elevation, computed locally.

   **Built 2026-09-28** (src/assistantpicture.ts; "capturing luma
   and color stats about the image (histogram data) to send to LM Studio
   would help out a lot"), all but the depth planes. It is measured from
   the frame the viewer and the Spectrums already show (framePixels in
   src/ui/spectrum.tsx, read at up to 2048 pixels across, no second
   render), in the main window, only while the assistant is on and only
   when a question is asked; the Console asks for it over the transport
   and goes without it after four seconds. It holds the share of pixels
   in each stop from under -5 EV to +2 EV and up, the mean, median, 2nd
   and 98th percentile in EV, clipping at each end per channel, the mean
   hue (named and in degrees) and saturation of shadows, midtones and
   highlights, a white balance lean from the near-neutral pixels (Oklab
   a and b), a 4 by 4 grid of mean EV and a color name, and, from the
   file's metadata, the capture time and the sun's elevation and phase
   (day, golden hour, twilight, night) by NOAA's solar position
   formulas. The GPS position is read only to compute the elevation and
   is never in the text. About 490 tokens for a demo photograph (by Qwen3's count); the
   read and the measurement take about 20 ms on a 2048 by 1536 frame in
   the browser (the first calls up to 60), so it runs on the main
   thread once per question. It goes with the answer call only: with a
   short form in the routing call, the set's 34 questions routed 33
   right against 34 without it. The model is told the numbers describe
   the picture as it looks now, to say what they show in plain words,
   and not to claim to see what they cannot show.
2. **Florence-2 (Microsoft, MIT license; 0.23B parameters), shipped like
   Depth Anything:** downloaded on request, ONNX (onnx-community's
   packaging), hash-pinned in models.json. It captions, finds objects,
   and turns a phrase into a region ("the cheetah's face"). It does not
   chat; it sees and labels. Regions let Heeler measure the parts that
   matter: "face: hue 28°, 0.4 EV under the background".
   Built 2026-09-28: free, a 970 MB download (fp32 graphs, int8
   token embedding, chosen by measurement; crates/heeler-vision
   florence.rs), offered on its own row in Preferences > Assistant and
   listed in Preferences > Models; the desktop command
   `florence_describe` reads the frame on screen.

   **Wired into the answers 2026-09-28** (src/assistantvision.ts). With
   Florence-2 installed and a photograph open, the main window runs it
   on the frame the picture report measures, in the same request from
   the Console (one reply carries both), with a 6 second limit of its
   own (the Console waits 8 for the reply): past it the answer goes with
   the report alone, and the run finishes and is kept for the next
   question about the same frame. Tasks: the detailed caption and the
   objects always, and phrase grounding for what the question names,
   found locally (a determiner and up to three words, leaving out the
   whole photograph, tones, Heeler's own capitalized names; at most
   two). Asking the routing call for phrases instead was measured on 24
   photo questions against the owner's Qwen3: local 22 right, the routing call
   18 (it named "the sky" for "What should I fix in this photo?" and
   "shadows" for muddy shadows), and it would need a second round trip
   after routing, so the phrases are local. Each region is measured from
   the same pixels as the report: its area, mean EV against the rest of
   the picture, and color name. An object the caption does not name is
   marked "not in the description", and one under 1% of the picture that
   it does not name is left out (a 0.2% "person" in an empty badlands
   view had a model advise lifting it). A phrase's box is labeled as the
   question's words, and when Florence-2 places only part of the phrase
   ("the cheetah" for "the cheetah's face") it says so. The text is 70
   to 240 tokens on the demo photographs by Qwen3's count, at most about
   330 (4 regions, a 260 character caption). Florence-2 took 0.6 to 0.95
   s per photograph for the caption, the objects and a phrase (release,
   M4 Max), plus 0.7 s to load and about a second to verify the weights
   on the first question of a session; the region text about 15 ms. The
   answer call's instructions say it is a machine description, not
   sight, from a small local model that has called a cheetah a leopard
   and a serval: use it for where things are and roughly what they are,
   never for species, names, places or brands, never to correct the
   user, and the photographer's eyes decide. The routing call does not
   carry it. Not installed, nothing changes, and the Console shows a
   one-line hint once a session (dismissible, never a dialog).
3. **Optionally, a vision chat model the user runs in LM Studio**, for
   questions about the image itself. The image goes to that local model:
   it leaves Heeler but not the device.

The assistant checks its own work in numbers. "Make this look like late
afternoon" becomes targets (warmer highlights, slightly cooler shadows,
midtones down a fraction of a stop, softer contrast); it proposes nodes,
renders locally, measures, and adjusts until the numbers hit. Numbers do
not know a white dress from snow, which is why regions help and why the
photographer's eyes decide.

## Where the user is (built 2026-09-29)

2026-09-28: "is the assistant context aware if the user is in
Adjustments or Node graph? that would matter a lot of the directions
being given." The main window reads, when a question is asked
(src/assistantphoto.ts, whereFactsOf, through setWhereProvider): the
workspace (Develop, Graph, Canvas); in Develop the right panel's tab by
its label and the layer being worked on (Base, an adjustment layer or a
Finish layer by its name); in Graph and Canvas the selected nodes by
type and card name, never their values, and the open group's name; the
viewer tool in hand. View state only.

- The answer call gets all of it as WHERE THE USER IS, labeled as data,
  and one rule for the workspace (WHERE_ANSWER): in Develop, sections,
  sliders and layers; in Graph and Canvas, which node to add, which
  output to wire to which input or where to splice it, and which
  Inspector controls to set, with a mask node into a node's mask input
  for one part of the picture; the other workspace's way only when this
  one cannot do it or the user asks. With nodes selected, "this node"
  means them.
- The routing call gets the workspace and the selected nodes' types
  with their node reference chapter, nothing else, and leans toward the
  node reference and graph chapters in Graph and Canvas and toward the
  Adjustments and Finish chapters in Develop. The local ranking leans
  the same way (graph sections times 3 in the graph unless the question
  names Develop, Finish, a section, slider or layer; times 0.5 in
  Develop unless it names the graph, a node, wire or port), and a
  question about "this node" is ranked with the selected nodes' names.
- The tour call gets the workspace and the selected types: in Graph and
  Canvas the graph's stops are offered whatever the words, Develop's
  tabs, sections and Finish tools only when the answer sends the user
  to Develop; in Develop the graph's only when the question or answer is
  about the graph. Canvas counts the graph as open while its nodes are
  shown, so a Canvas tour does not switch to Graph.

Measured against the owner's qwen/qwen3-30b-a3b-2507, routing call alone: the
guide's 34 questions routed right 33 times with no workspace (as
before) and 34 with Develop; the workspace set
(src/assistantworkspace.json) 10 of 10 in Develop and 11 of 12 in
Graph (the vignette went to the node README and utility, the local
material still carrying the Vignette node's section). Asked through,
Graph answers named nodes and wires (Recolor with a Hue Range Mask,
Smart Mask into Exposure for the sky, Grain spliced in, Selection Mask
into Blur) and their tours walked graph stops; Develop answers and
tours kept to sections and sliders.

## Features, in order

1. **Help.** Answers from the user guide (docs/user-guide), each citing
   its chapter with a jump to it. Read only.
2. **Explain and debug.** Measurement tools over the graph: a node's
   output against its input (shadow EV, clipping, color shift), which
   node moves a quantity most, what a region measures. Useful with no
   model at all ("Explain this graph", "Describe this photo's light");
   the assistant is a front end to them. This answers #20's "what node
   is causing my image to over-expose the shadows by two stops?"
3. **Proposals in a new take.** The assistant never edits the user's
   take. It builds in a new one ("Take 3 (assistant)"), shown as ghost
   nodes with a before and after; the user compares with the Takes
   tools and accepts or discards the whole plan. Resetting and
   rebuilding a graph is the same: a new take.
4. **Catalog search.** Metadata (dates, lenses, ratings, ISO, "after
   sunset" from the capture time and sun), and content through
   Florence-2: each photograph captioned once, locally, the caption kept
   in the catalog, so "photos with a giraffe" is a text search.

Guided tours (below) came next after Help (first version built
2026-09-28), since they build on it and are the assistant's teaching
role.

## Guided tours (first version built)

2026-09-28: "take a question and have it generate a guided tour of
how to do something. 'how do I make a photo black and white' -> click
here, to do this, then here to do this. then 'would you like to learn
more about how this node works or similar things you could do with the
nodes?' something that can teach you how to use the app."

**Tour stops, never free text.** A model cannot be trusted to name a
button precisely; it would invent them. Heeler keeps a fixed list of
tour stops: every tab, panel, section, important control, menu item and,
in Graph mode, node types and their ports. Each stop has a stable id,
a short name and a one-line description, and Heeler knows how to find it
on screen and how to tell when the user has done it. The model answers
a "how do I" question by choosing stops from that list, in order, with
one sentence each, as JSON. Heeler checks every id against the list and
drops an individual step with an id it does not know (falling back to the plain
answer when no usable steps remain), so a tour can never point at something that does not exist.
Many controls already carry test ids; the stop list reuses them where
they are stable, and gives the rest ids of their own.

**The offer, built on yes** (2026-09-29: "what it should do after
giving me directions is ask something like 'Say yes if you would like
for me to show you?' then if I say yes build the steps. This should be
an option after every prompt, considering it is possible to show
something. If the user can't be shown then just be explicit about it
'I'm sorry I can't give you a tour, but I can answer another
question'").
- After every answer (first questions, follow-ups, questions from the
  end card and from Learn more), when the answer gives directions that
  could be shown, it ends with the offer line, "Would you like me to
  show you? Say yes, or press Show me.", and a Show me button.
  Directions: the question asks how (the local how-to check), or the
  answer gives steps (a numbered list, or a sentence telling the user to
  open, click, drag, set...), and at least one stop fits beyond the
  places every tour passes (showableStops in src/tour.ts).
- The tour is made only then: on a short reply taking the offer (yes,
  sure, ok, show me, please and the like, matched locally, eight words
  at most) while the offer is the last turn, or on Show me. Nothing is
  made in the background. A building line shows while the tour call
  runs, and the tour starts in the main window once made.
- A short "no" (no, no thanks, not now) declines with a line of
  Heeler's own and no model call; any other question leaves the offer
  behind, and "yes" with no offer pending is asked of the model as a
  question.
- No offer for an answer with nothing to show. Asked to be shown anyway
  ("show me", "can you show me?"), and when a tour cannot be made or
  made whole, the assistant says exactly: "I'm sorry, I can't give you a
  tour of this, but I can answer another question."

**Walking the tour.**
- The answer shows a Show me button next to the steps.
- Heeler dims the window and spotlights the first stop, with its
  sentence beside it, then waits for the user to do it (the section
  opens, the Treatment switches, the slider moves: each stop names the
  state change that completes it) before moving on. Next, Back and Stop
  are always there; a stop the user has already done is skipped.
- If a stop is off screen (a closed panel, another mode), the tour opens
  the way to it first, as its own step, rather than jumping there
  silently.
- Graph mode works the same: stops can be nodes, ports and wires ("this
  is the Black & White node; its Blue input is here").

**Graph tours are whole networks** (2026-09-29: "Check the plan
is a complete network before showing it. Repair and drop steps"; live
Graph tours on 2026-09-28 added a Recolor node and never wired its
mask, added a Smart Mask and pointed at its lone mask output without
adding the Exposure it feeds, added an unneeded Tone Profile and a wrong
"Add an Output node" step, and added connect steps after a splice that
had already made those wires). After the JSON passes the check,
src/tourplan.ts plays the plan on a copy of the main window's graph
through the reducer without its tier gate (reducePlanCopy; the live
state is never touched), and:
- drops an add step for a node type the answer never names, with every
  step about that node, and any step asking to add an Output or an Image
  Source;
- adds a node the answer tells the user to add ("add a Blur node",
  "type Recolor to add it") that the plan never adds (live: the palette
  opened for Recolor and no Recolor added), before the plan's first
  step about it;
- makes a step at a lone port the wire it implies when its sentence
  names one other node ("Drag from its output to Exposure's mask");
  otherwise drops it when its sentence asks for a drag or the port is on
  a node the plan adds (a port stop only points), the wires a whole
  network needs being made below;
- drops a connect or splice whose wire the plan already made, or that
  the reducer refuses because the plan already fed that input;
- moves a splice that comes after a wire into or out of its node to
  right after the node's add (a splice lifts the node's wires first, so
  a mask wired before it would be lost);
- splices a picture node the plan adds whose output goes nowhere;
- feeds a mask node the plan adds the photograph (Image Source into its
  input) and wires its output into a mask input of a node that changes
  the picture: the one picture node the plan adds with a free mask
  input, else the one mask-taking node the answer names, added and
  spliced for it; a picture node the plan adds with a free mask whose
  sentence in the answer names one mask node gets that mask node.
Each repair is a DEBUG log line ("tour plan: ..."), with the plan
before and after; nothing of it goes in the chat. A plan still not
whole (a node off the picture's path, a mask feeding nothing, more than
16 steps, no step left) is dropped, and the user hears the sorry line.
Measured against the owner's Qwen3 on 2026-09-29 (src/__tests__/tour.live.test.ts
with HEELER_TOUR_WORKSPACE and HEELER_TOUR_FOLLOWUP): the four Graph
questions were offered a tour each; across three runs grain was
repaired and valid every time, blur the background repaired and valid
twice (Blur spliced, a Selection Mask added, fed and wired into Blur's
mask), desaturate the reds valid twice after repair, darken the sky
valid once (the answer sent the user to Develop's Sky Rescue), and the
reply was dropped on an invented stop four times
(control.sky-rescue.threshold, control.recolor.by, graph.add.sky-rescue,
menu.select.invert), which the check did then. Since the owner's word the
same day ("drop just the invented step and recheck"), an invented stop,
an unknown port or a wire whose ports do not fit drops only its own
step (a DEBUG line counts them without recording model text), and the whole-network check runs on
the rest; the tour goes only when no step is left or the rest is not
whole. Re-measured on the four Graph questions twice: 7 of 8 valid, two
of them rescued (desaturate the reds lost three invented Recolor
controls, darken the sky two invented Sky Rescue controls); the one
drop was blur the background, not whole. The follow-up "how do I simulate infrared?"
was offered a tour; its first reply named bw.infrared, which did not
exist, so the Black and White filter and the Infrared fold and its four
dials now have stops, and the next reply validated with Film and Filter.

**Learn more.** When a tour ends, Heeler offers two or three follow-ups
built from the app, not guessed: how the node or section just used
works (its node reference chapter), and similar things the user could
do, taken from what the guide and the node catalog place near it (for
Black and White: Color Bend, Film, Infrared). Choosing one starts a new
answer or a new tour.

**Rules it keeps.**
- Free, like questions: teaching the app is the clearest case for free.
  A stop inside a Pro feature shows the Pro badge, from the same Pro
  list the answers use, and the tour says so at that stop.
- A tour never changes the edit. It points; the user clicks. Nothing is
  done on the user's behalf.
- Nothing new leaves the machine: the same local model, with the stop
  list added to what it reads.
- Tested like the retrieval: a set of "how do I" questions with the stop
  sequence each should produce, run against the stop list so a renamed
  control fails a test instead of a tour.

**The real work** is the stop list (ids, names, how to find each on
screen, what completes it) and the spotlight that follows the app's
zoom and panes (the ui-zoom trap applies: measure from offsets, not
client rects inside CSS zoom). The model's part is small once the list
exists.

**Built 2026-09-28** (first version; the owner asked for it the same day, and
for first-class graph coverage: "I think guided tours will be really
helpful for node graphs").
- The stop list (src/tourstops.ts): 815 stops, generated where the app
  has a definition to read (the workspaces, PANEL_TABS, every SECTIONS
  section with its switch and rows, the export sizes, the crop ratios,
  the Preferences pages, and in the graph every palette node: adding
  it, its card, each port by makeNode's seats and portName's names,
  with the kind of pipe it takes), the rest by hand (the Black and White
  treatment and mix, the Curves and Color Wheels widgets, crop and
  straighten, the photograph itself, the
  beginner's menus, Export, the Finish panel and toolbar, the Library,
  and the graph's gestures: palette, search, connect with two ports,
  disconnect, splice, context menu, groups, backdrops, arrange,
  Inspector, pop-out). A test renders the app, opens every place and
  finds every stop's element.
- The model's part (src/tour.ts): a local "how do I" check (33 of the
  34 guide questions, every tour question, none of seven "what is"
  questions), then a third call after the answer with the answer, the
  material shortened, and at most 90 relevant stops (220 with a larger
  context). The check drops a step with an unknown id, or a connect
  whose ports do not fit, on its own and keeps the rest; malformed
  JSON or no step left drops the tour; two measured slips are repaired (a splice
  with no node, two fitting ports as separate steps), and a picture
  node the tour adds but never wires gets a splice step.
- The walk (src/tourwalk.ts, src/ui/touroverlay.tsx,
  src/tourgeometry.ts): in the main window, an SVG dimming with
  cut-outs, measured from offsets through zoom, scroll and transforms;
  a place on the way is its own step, opened only by the user or by
  OPEN with a view command (VIEW_COMMANDS; a test holds every dispatch
  to it); Escape stops.
- Keys during a tour (2026-09-29: a step said to press
  Shift+Space and nothing happened): the step card had taken the focus
  (NEXT) when the tour started, the card is a role="dialog", and the
  app's key handler stands aside for every key but Escape inside a
  dialog. The step card now takes no focus and a click on its buttons
  leaves the focus where it was; the handler lets the card through
  (data-tour-card); a chord such as Shift+Space is a shortcut even with
  a button focused; the tour hears Escape as it bubbles to the window,
  so an Escape the node palette keeps closes only the palette. Only the
  end card focuses its follow-up field. A tour asked for from the
  Console brings the main window forward. The add-node stop carries its
  own instruction (TourStop.how), shown under the model's sentence
  every run: "Press Shift+Space or click the add node button".
- Where the card goes in the graph (2026-09-29: on a connect step
  the card sat over the Luminance Mask whose input port it pointed at,
  "making it hard to see"): placeCard avoided the port holes only. It
  now also takes the whole node card that owns each spotlighted port
  (nodesOf: both nodes of a wire, a node step's card), measured from
  offsets like the holes, as areas to leave clear: the first place
  that covers neither a hole nor a node, else one that covers no hole
  and the least of the nodes, a hole covered only when nothing clears
  them. Measured again on the next frame after a wheel or a drag, so
  the card follows a pan or zoom. Seen in the test browser (screenshots at
  1440 by 900).
- Find a Node under a tour (2026-09-29: "it would help to
  highlight the 'find node' dialog to emphasize where to type, it was
  darkened like rest of the app"): the add-node step completes when the
  palette opens, and the next step (a node not yet in the graph) had
  nothing on screen, so the palette sat under the dimming. Now, while
  a tour runs and the palette is open, however it was opened, the
  overlay measures the palette's box from offsets (paletteOf) and cuts
  it a hole of its own whatever the step points at; placeCard takes it
  as a hole, so the card keeps clear of it; its search field has the
  focus; the card adds "Type a few letters of the node's name in Find
  a Node" and drops the off-screen note. Escape in the palette still
  closes only the palette, and picking a node still completes a node
  step.
- The step count (2026-09-29: the black and white tour walked 5
  steps while the Console said 8): the Console named the steps the model
  wrote, the walk leaves out those already done when it starts. The
  offer carries no number now; the walk counts at its start, in the main
  window, and the Console says that count while it runs.
- Learn more: the chapter or node reference used, then a stop of the
  same chapter not visited, the catalog neighbor, or an example network
  that uses the node.
- Measured against the owner's qwen/qwen3-30b-a3b-2507: 10 to 17 s a tour
  call; black and white, crop to 16:9, export at 2048, the dust spot, a
  saturation node (spliced by Heeler), the red channel as a mask and,
  on a free copy, an S curve (both Curves stops marked Pro) validated;
  inserting a node between two was dropped (the answer named no node to
  splice). Fixed along the way: the model borrowing Exposure sliders
  for "Alt-click, then paint" and for an S curve (the photograph and
  the curve now have stops; an invented control.exposure.luminance was
  dropped by the check), a tour for the Finish tab wandering into the
  graph (graph stops now only when the question or answer is about the
  graph). Still seen: a spurious Photo menu step before Export (the
  answer's own "Photo > Quick Export"), and a mask wire left as a
  pointed port when the answer names no node to limit.
- Not yet: stops for each node's Inspector controls by name (the
  Inspector's controls are one stop), the Presets, History and Metadata
  tabs' own controls, Canvas mode's floating panels, spotlighting inside
  a popped-out graph window (the tour walks the main window), and a
  check in the native WKWebView of the offset measurement (verified in
  jsdom by arithmetic and in the test browser against client rects).

## Approval

- The assistant says its plan in words and shows it before anything
  changes, as #20 asks ("add new nodes between node X and node Y").
- The approval shows the actual change, not only the assistant's summary
  of it.
- One approval per plan, not per node. A plan lands as one undo entry in
  its own take.

## Safety and privacy

- Off by default. Nothing happens until the user enables the assistant
  and names a local server.
- Local only (above), so nothing the assistant reads leaves the home network.
- Prompt injection: file names, EXIF text, captions, node notes and
  catalog text all reach the assistant and could carry text meant to
  steer it. It is passed as data, labeled as such; and the assistant
  can act only through the bridge, only after approval, only into a new
  take, with the approval showing the real change.

## Free for questions

2026-09-28, replacing the first rule (the whole assistant Pro, "I
could see someone using this to bypass pro tier locked features to add
pro-locked nodes to the graph"): "if we keep assistant just answering
questions, it shouldn't be pro locked. It could be more useful to
explain to someone how they could still achieve the desired outcome but
they are blocked because the feature they need is Pro tier", for
example "1. click here on this feature 2. set this value 3.
Unfortunately, this is only available when unlocking Pro".

- Asking questions is free on every copy: the Preferences Assistant
  tab, the Console's Assistant tab, and the backend's validate, chat and
  context-length calls. The notice and the untested-model
  acknowledgment are asked on every copy, as before.
- Anything that changes the edit (proposals, and any later feature that
  acts) stays Pro, and the reducer's tier gate is what enforces it: the
  assistant acts only through the bridge, the bridge dispatches through
  the reducer, and the tier gate runs first in the reducer, before undo
  bookkeeping, so a refused command leaves no trace. That was already
  the real wall when the whole assistant was Pro; questions never reach
  it, since they change nothing.
- The assistant knows which features are Pro from the app's own gate,
  never from the guide: the Develop sections the panel marks Pro (the
  rule that draws the PRO badge, held to the reducer by
  entitlement.test.ts), then the rest of what blockedByTier refuses, by
  name (proFeatureNames in src/state.ts). On a free copy the facts carry
  that list, and the answer says "This needs Heeler Pro." at a step that
  uses one, gives a free way to the same result when the material has
  one, and mentions Help > Upgrade to Pro once at most, never pressing.
  On a Pro copy the model is told nothing about tiers.
- The model does not guess which step is Pro (2026-09-28, "fix the
  false Pro flag": a black and white sky answered with the free mix's
  Blue slider still said it needed Pro, and five prompt wordings could
  not stop it). On a free copy the guide material is marked from the
  same list: a chapter whose title is a Pro feature (Sky Rescue, Curves,
  a Finish layer's chapter) is headed PRO, every other chapter FREE, and
  inside a free chapter a section whose heading names a Pro feature
  (Film, filter and development, when the photograph is converted)
  carries [PRO]. The model says "This needs Heeler Pro." only for a
  step from material marked PRO. After the answer, a guard removes the
  claim, and the upgrade line with it, when the reply names no Pro
  feature, alias or Pro chapter at all; it never adds a claim, and a
  Pro copy's reply is never touched (src/assistantguide.ts, tieredChapter
  and withoutFalseProClaim). Measured on the owner's Qwen3 30B: the six cases
  (Curves, Depth of Field, color sky, black and white sky, export,
  straightening) went from 5 of 6 to 18 of 18 over three runs.
- Checking the first rule found the one door that skipped the reducer:
  `Heeler -x` (batch scripting) and `Heeler serve` ran without any Pro
  check on a public build. Fixed on v26.4 (33a48546): both now read the
  same Pro status the window does. Any new door (the MCP door, if it
  ever comes) goes through the reducer or through that same headless
  check.

## Setup, as the user sees it

the owner's workflow, 2026-09-28, with the order that makes the model list
real:

1. Free for questions: every copy sees the same Assistant tab, with no
   upgrade panel.
2. Nothing is on by default. The user opens Preferences, Assistant.
3. A checkbox turns it on and shows the disclaimer, accepted once and
   recorded with its date, the way the EULA acceptance is.
4. The server address, prefilled with LM Studio's default,
   `http://localhost:1234`.
5. **Validate**, which says what is wrong in words: the address is neither
   this computer nor the home network; nothing answers there (is LM Studio running with its
   server started?); the server has no model loaded; or connected, with
   how many models.
6. The model dropdown, filled from the server's own list after
   validating: tested models marked "Tested with Heeler", any other
   model asking for the one-time acknowledgment when picked.
7. The tested models listed with links to their pages, and links to
   apps that run them (LM Studio and similar), worded "works with", never
   "recommended by". Opening a third-party site is covered by EULA
   section 7.
8. Florence-2 on its own row with the usual download card (size,
   license, Download), optional: the assistant works from numbers
   without it.
9. Enabled and validated, the assistant's tab appears in the Console.
   If the server goes away later, the tab stays and says it is not
   connected, with a link to Preferences; no dialog at launch. A lapse
   of Pro changes nothing here: the tab stays, and the answers start
   saying which steps need Pro.

## Preferences

A new Assistant tab:

- An enable switch, off by default. Enabling shows the disclaimer:
  Heeler is not responsible for instructions or answers from another
  model; review every proposal before approving it.
- The server address and the model.
- Status: connected, not reachable, or not configured. Checked when the
  assistant is enabled and when its tab opens, never with a dialog at
  launch: a missing assistant is absent, not nagging.

## Models

### The tested list is built into Heeler

The list of tested models is part of Heeler's code, like any other part
of the app, and changes with a release. There is no file to edit,
nothing is fetched, nothing is signed. Changing the list means modifying
Heeler, which the EULA (section 4) already prohibits. Releases come
often enough (26.3.1, 26.3.2 and 26.4 shipped days apart) that a new
model waits days, not months.

- A **tested model** works with no questions asked, marked "Tested with
  Heeler". Tested means its license was checked on its model card (code
  and weights, Apache-2.0 or MIT) and Heeler's tasks were run against it:
  Help answers citing the right chapter, graph proposals that validate,
  debug questions answered from the measurements, and for vision models,
  regions checked against Florence-2's.
- **Any other model** works after a one-time acknowledgment when the
  user picks it: "This model has not been tested with Heeler. Its
  license and its answers are the responsibility of whoever runs it."
  Heeler records the acknowledgment per model name, with the date.
- Matching is by the model name the server reports, ignoring case and a
  trailing quantization tag. A name is not proof of the weights behind
  it, which is why the acknowledgment, not the list, carries the user's
  responsibility.

### Tested so far

- **Qwen3-30B-A3B-Instruct-2507** (Apache-2.0), added 2026-09-29 at the owner's
  word: the model the assistant was built and reviewed against on the owner's
  LM Studio (chapter picks 33 of 34, tours 7 of 7 valid). Listed under
  LM Studio's, Hugging Face's and Ollama's names; the earlier
  Qwen3-30B-A3B and the Thinking variant are not.

### Starting candidates (as of 2026-09-28, checked again before listing)

- Qwen3-VL 2B and 4B: Apache-2.0; answers questions about images and
  locates objects.
- SmolVLM2 2.2B (Hugging Face): Apache-2.0.
- Moondream2: Apache-2.0; captions, answers, detects, points.

Traps to avoid, like Depth Anything's non-commercial Base and Large
weights: Qwen2.5-VL-3B is under the Qwen Research License
(non-commercial) though its siblings are Apache; Gemma-based models
carry a custom license with use restrictions. Each model is checked on
its own card, never by family name.

Florence-2 is the one model Heeler itself downloads, so it follows the
existing rule for shipped models: license, weights and training data
recorded on the open-source page (docs/user-guide/legal/open-source.md),
weights pinned by hash.

## Legal

This version fits the EULA and privacy policy as written (a reading of
the documents, not legal advice). No counsel review is planned for it:
both follow-up rounds the engagement included are used (the Polar
activation wording, and one small edit after it), so any future review
is a paid one, and the owner wants it shared across several changes rather
than bought for one.

- The privacy policy promises photographs stay on storage the user
  controls and nothing goes to Vagabond Burro for machine-learning
  processing. Local only, off by default, keeps both.
- The privacy policy already lists downloading a machine-learning model
  the user requests, which covers Florence-2.
- EULA section 7: third-party materials and services are governed by
  their providers' terms. A model the user runs in LM Studio is that.
- EULA warranty section: no warranty of "a particular creative or
  technical result".
- EULA section 4: the documented automation interfaces may be used;
  modifying Heeler (including its built-in tested list) is not allowed.
- What users must be told lives in the app, not the agreement: the
  disclaimer on enabling and the acknowledgment for an untested model
  are notices, like the model download consent card.

The rule that keeps this true: **nothing the assistant reads leaves the
user's computer and home network, no default sends a picture anywhere, and nothing goes through
Vagabond Burro.** Anything that would break it is a change to the
privacy policy first, and needs the product decision and counsel before code.

## Open questions

- Built: the main window keeps a conversation for the session, through
  Console closes and reopens. Clear or quit discards it; nothing is saved.
- Where it lives: a Console tab (the owner's workflow above); whether it can
  also sit beside the graph while a plan is proposed.
- Whether the assistant may propose a File node, which names a path on
  disk.
- Cancel, streaming and timeouts for slow local models.
- Testing: a scripted mock server, so every suite stays offline.
- Speed of Florence-2 and of a 2B chat model on the owner's Mac, measured
  before anything is promised.

## Later, only if needed

Kept so the thinking is not lost; none of it is planned.

- **Cloud services** (ChatGPT, Gemini, Claude, any hosted API), deferred
  on purpose by the owner. They would need three wording additions, drafted for
  a future counsel review shared with other changes: the privacy
  policy naming the assistant among features that talk outside the
  device and what it sends; an EULA section 7 line for an AI service the
  user configures; and a short EULA paragraph that answers are
  suggestions the user reviews. A preview would go to a cloud model only
  by an explicit per-request approval.
- **The MCP door** (M7.2), for outside CLI agents: it waits with cloud
  services, since the agents people would bring through it are cloud
  services.
- **A tested list fetched from the public repo**, if waiting for a
  release to add a model ever hurts: a `tested-models.json` read weekly
  from the repo's `main` while the assistant is enabled, with the
  built-in list as the fallback, kept separate from `models.json` (which
  installs weights), and signed by the owner with its own key so an altered
  list is rejected and tampering is plainly circumventing a security
  control (EULA section 4).
