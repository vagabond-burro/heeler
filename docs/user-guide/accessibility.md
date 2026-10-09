# Keyboard and screen reader checklist

Follow one editing session without a pointer. On macOS, turn on VoiceOver and
keyboard navigation in System Settings. On Windows, turn on Narrator. Use the
screen reader's interaction mode when an arrow key belongs to a slider rather
than to reading text. These checks cover native webview and operating-system
behavior that automated DOM tests cannot certify.

- [ ] **Library and thumbnail strip:** Tab from the menus into the Library,
  select a photograph, filter the list and change its sort direction. Hear the
  photograph's filename and the names of the filter and sort controls. In a
  large strip, use Up, Down, Home and End to reach both ends. Focus remains
  visible, and the selected photograph agrees with the editing viewport.
- [ ] **Editing panel Slider:** reach Exposure by Tab or the app's A navigation
  mode. Hear "Exposure", "slider" and its current value. Left and Right change
  that value; Home and End reach the track's limits. The photograph updates as
  it does when the track is dragged. The adjacent value field announces its name.
- [ ] **Color Tune band sliders:** choose a band, then reach its adjustment
  tracks. Hear each full adjustment name, "slider" and a changing numeric value,
  including when the panel shows abbreviated labels. Arrow keys adjust the
  selected band without moving the page.
- [ ] **Preferences tracks and switches:** open Preferences, visit Editing &
  Brush and adjust a step-size track. Hear the track's name and value. Return to
  General and toggle a switch with Space or Enter. Hear its setting name and
  on/off state. Tab reaches every category and search result.
- [ ] **Segmented controls:** visit App zoom in Preferences, the curve
  interpolation selector and the viewer's zoom choices. Hear the group's name,
  each button's name and whether it is pressed. Enter or Space chooses the same
  option as a pointer click.
- [ ] **Catalogs and recovery:** open Catalogs. Hear "Catalogs and recovery"
  and "dialog". Tab and Shift+Tab stay inside it. Read a disabled recovery
  action's explanation. Close the dialog and hear the opening control again.
- [ ] **Confirm and selection dialogs:** open a confirmation and cancel it;
  open Smooth Selection, Feather Selection, Resize Selection and a range
  selection dialog. Hear each dialog's title, its controls and current values.
  Tab stays inside; Cancel and Done return focus to the opening control.
- [ ] **Other dialogs:** open Preferences, User documentation, Save selection
  as group and Bake to an image. Hear their titles and
  "dialog". Check forward and reverse Tab at both ends, then close and confirm
  focus returns. During stitching, hear its progress; no editing shortcut acts
  on the photograph behind the dialog.
- [ ] **Recovery notice and status:** with a synthetic recovery test session,
  hear the recovery notice as an alert and reach its available actions. Trigger
  a status flash and hear it without focus leaving the current control. Hover
  hints do not interrupt a pending flash.
- [ ] **Pop-out faces:** open Color Wheels, Curves, Relight, Recolor, Color Tune,
  Color Bend, Graph, Spectrums and Console. Hear the new window title, each
  control's name and each segmented button's state. Use Bring it back and the
  native close control separately. Focus returns to the control in the main
  window that opened the pop-out.
- [ ] **Menus and context menus:** reach a top menu with Tab, open it with
  Enter, move with Up and Down, then activate a command with Enter or Space.
  Hear menu item names and submenu state. Press Shift+F10 on a thumbnail to
  open its context menu. Escape closes the menu and returns focus to its opener.
  Disabled commands remain visible and explain where they apply.
- [ ] **Focus visibility and contrast:** complete the session in each theme
  and at the preferred app zoom. The focus indicator stays visible without
  relying on color alone; labels and disabled explanations remain readable.

Record the operating-system version, screen reader, app build and any control
whose spoken result differs from this checklist when reporting a problem.
