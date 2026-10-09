# Connecting a camera over USB

> **Development builds only, since 2026-08-26.** This page used to sit
> in docs/user, which is the folder the Help viewer ships and renders.
> It moved out when tethering stopped being offered in shipped builds:
> On the milestone, "Since it's hard to verify numerous cameras, I
> don't think making it available even as an experimental feature is a
> good idea for the commercial release." A Help page for a tab the
> build does not have is the same broken promise as the tab itself.
> The instructions below are still true, and still what to follow in a
> development build; move the file back into docs/user on the day the
> feature ships.

Heeler can talk to a camera directly over its USB cable: it reads what
the body can do, fires the shutter, and imports each frame through the
same path as everything else in your catalog. Nothing is ever removed
from the camera's card.

This page is about getting the connection to happen. What differs
between Windows, macOS, and Linux is not Heeler, it is who else on your
computer already wants the camera.

## Before you start

- Run a development build, and turn on **Experimental features** in
  Preferences. The **Tether** tab appears in the panel rail once it is
  on. Both halves are needed: the toggle is absent from shipped builds,
  so there is no way to reach the tab from one. Direct USB capture is
  built against a Panasonic Lumix; other bodies are untested.
- Set the camera's USB mode on the body itself. A camera set to
  charging or card reader shows up on the bus as the wrong kind of
  device and no software can capture from it. On a Lumix, that means
  PC(Tether) or PC Remote rather than PC(Storage).
- Open the Tether tab and press **REFRESH** under CAMERA. Your camera
  should appear by name, with a gray number after it like `04da:2382`.
  That number is the vendor and product ID. Keep it handy: on Windows
  you will need to match it exactly.

## Windows: the driver step

This is the one platform where the first connection cannot succeed
without doing something outside Heeler.

When you plug in a camera, Windows binds it to its own PTP driver, the
one that makes the camera show up in the file browser and the system
photo import wizard. That driver does not let another program take
over the USB interface, and there is no way for an application to ask
nicely.
So Heeler sees your camera in the scan, offers **CONNECT**, and then
fails with a message about an incompatible driver.

The fix is to change which driver Windows binds to that one camera.
The usual tool for this is **Zadig**, a small free utility from the
libwdi project. It is not made by us and Heeler does not bundle it.
Get it from [its own site](https://zadig.akeo.ie). It is a single .exe
with no installer.

### Read this part first

Swapping the driver is a real trade, not a formality:

- **Other software stops seeing the camera.** While WinUSB is bound,
  Windows no longer treats the body as a camera. It disappears from
  the file browser, from the photo importer, from the Windows import
  wizard, and from the manufacturer's own tether app. Heeler can talk
  to it; nothing else can.
- **It sticks.** The binding is per camera model, and it survives
  reboots, cable swaps, and different USB ports. A second body of a
  different model needs its own pass through Zadig.
- **Nothing touches the card.** This is only about which driver speaks
  to the camera. Your photographs are not involved.
- **It is reversible in about a minute.** The undo steps are at the
  bottom of this page. Read them before you start, not after.

If that trade does not suit you, the folder watch in the SESSION half
of the Tether tab is the alternative: run the manufacturer's tether
app, point Heeler at the folder it writes into, and every arrival
imports. No driver changes, and the camera keeps working everywhere
else.

### Step by step

1. Connect the camera, turn it on, and set its USB mode. Quit any
   other tether software.
2. In Heeler's Tether tab, press **REFRESH** and note the gray
   `vvvv:pppp` number beside your camera.
3. Run Zadig. Say yes to the administrator prompt.
4. In the menu bar, open **Options** and tick **List All Devices**.
   Leave **Ignore Hubs or Composite Parents** ticked.
5. Pick your camera in the dropdown. **Check the USB ID field against
   the number from step 2 before doing anything else.** The dropdown
   lists everything on the bus, keyboards and mice included, and the
   names are not always obvious. Matching the ID is what stops you
   from swapping the driver on the wrong device.
6. The left box shows the driver bound now, something like
   `WUDFWpdMtp`. Set the right box to **WinUSB** using the arrows
   beside it.
7. Click **Replace Driver**. It takes anywhere from a few seconds to a
   minute. Windows may show a driver installation prompt; accept it.
8. Back in Heeler, press **REFRESH**, then **CONNECT**. The camera's
   name and its capabilities appear.

If CONNECT still fails after this, press **COPY DIAGNOSTICS** and send
the report to support@heeler.app. That report is how bodies we do not
own get supported.

### Undoing it

To give the camera back to Windows and to your other software:

1. Open Device Manager (right-click Start, or press Windows+X).
2. Find the camera. After the Zadig pass it sits under **Universal
   Serial Bus devices**, usually under its own name.
3. Right-click it and choose **Uninstall device**. Tick **Attempt to
   remove the driver for this device** in the dialog, then confirm.
4. Unplug the camera and plug it back in. Windows binds its own PTP
   driver again, and the camera reappears in the file browser, the photo importer,
   and the manufacturer's tether app.

Redo the Zadig pass whenever you want Heeler to have it back.

### Why Heeler does not do this for you

We could ship a driver package that binds WinUSB to a list of camera
models at install time. We decided not to, deliberately.

Doing it from an installer would mean quietly taking cameras away from
software you did not ask us about, on your machine, for models we
guessed you own. It would also only ever work for bodies on a list we
maintain, which is the opposite of how the rest of the tether works:
any camera presenting a standard imaging interface is a candidate here,
listed or not.

So the driver stays your call, made knowingly, with a tool built for
exactly that job and an undo you can run yourself.

## macOS

Nothing to do. macOS runs its own PTP daemon that grabs the camera the
moment you connect it, and it restarts itself whether or not you ever
opened Photos. Heeler asks it to let go and retries the connection
automatically. If a connection still fails as busy, quit Photos and
Image Capture and press CONNECT again.

## Linux

Not yet verified, so treat this as a starting point rather than a
recipe. No driver swap is needed, but the device node has to be
writable by your user. A udev rule does it, using the vendor and
product ID from the scan:

```
SUBSYSTEM=="usb", ATTR{idVendor}=="04da", ATTR{idProduct}=="2382", TAG+="uaccess"
```

Save that as `/etc/udev/rules.d/70-heeler-camera.rules`, then:

```
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug the camera and plug it back in. If your desktop auto-mounts
cameras (a GNOME or KDE file manager showing the camera as a drive),
unmount it there first: that mount holds the body the same way macOS's
daemon does, and Heeler does not yet release it for you.
