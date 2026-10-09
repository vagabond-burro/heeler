# Python scripting examples

These scripts use only the public `heeler` package and Python's standard library.

## Promote picks and clear rejects

Works in the app or batch.

```python
import heeler

images = heeler.images()
picks = [image["id"] for image in images if image["flag"] == "pick"]
rejects = [image["id"] for image in images if image["flag"] == "reject"]

if picks:
    heeler.rate(picks, 5)
if rejects:
    heeler.rate(rejects, 0)

print(f"Promoted {len(picks)} picks; cleared {len(rejects)} reject ratings")
```

## Apply and save a batch adjustment

Batch script. Node ids should be confirmed with `nodes()` for the target graph family.

```python
import heeler

for image in heeler.images():
    if image["stars"] < 4:
        continue
    heeler.open_image(image["id"])
    node_ids = {node["id"] for node in heeler.nodes()}
    if "exposure" not in node_ids:
        print("Skipped graph without exposure node:", image["name"])
        continue
    heeler.set_param("exposure", "exposure", 0.2)
    heeler.save()
    print("Adjusted", image["name"])
```

## Export selected catalog images

Works in the app or batch when ids are supplied.

```python
import heeler

targets = [
    image["id"]
    for image in heeler.images()
    if image["stars"] >= 4 and image["flag"] != "reject"
]

report = heeler.export_images(
    "exports/web",
    ids=targets,
    format="jpeg",
    quality=85,
    max_edge=2048,
    template="{name}-{stars}star",
    keep_metadata=False,
)

print(f"Wrote {len(report['written'])} of {len(targets)}")
for item in report["failed"]:
    print("FAILED:", item["name"], item["error"])
```

## Inspect every parameter on a node type

Works in the app or batch.

```python
import heeler

def describe(node_type):
    spec = next(
        item for item in heeler.registry()
        if item["type"] == node_type
    )
    print(spec["label"], f"v{spec['version']}")
    for param in spec["params"]:
        print(
            f"{param['name']:<20}",
            f"default={param['default']}",
            f"ui={param['min']}..{param['max']}",
            f"hard={param['hard_min']}..{param['hard_max']}",
        )

describe("heeler.exposure")
```

## Build alternate takes

Live app or external script only.

```python
import heeler

original = heeler.takes()["active"]
for exposure in (-0.5, 0.0, 0.5, 1.0):
    heeler.new_take(f"EV {exposure:+.1f}")
    heeler.set_param("exposure", "exposure", exposure)

heeler.switch_take(original)
print([take["name"] for take in heeler.takes()["takes"]])
```

## Make several edits one Undo step

Live app or external script only. A gesture coalesces repeated changes that use its matching key.

```python
import heeler

with heeler.one_undo("exposure.exposure"):
    for value in (0.1, 0.2, 0.3, 0.4):
        heeler.set_param("exposure", "exposure", value)
```

## Render an intermediate node

Live app or external script only for intermediate-node targeting.

```python
import heeler

node = next(
    item for item in heeler.nodes()
    if item["type"] == "heeler.curves"
)
width, height = heeler.render(
    "curves-output.jpg",
    node=node["id"],
    quality=95,
)
print(f"Rendered {width} × {height}")
```

## Configure and bake an HDR stack

Live app or external script only.

```python
import heeler

members = ["5101", "5102", "5103"]
stack = heeler.stack_create(members, "hdr")
info = heeler.stack_configure(stack["id"], align=True)

if info["missing"]:
    print("Cannot bake; missing:", info["missing"])
else:
    baked = heeler.stack_bake(stack["id"], format="dng")
    print("Baked", baked["name"])
```

## Back up and restore hotkeys

Live app or external script only.

```python
from pathlib import Path
import heeler

path = Path("heeler-hotkeys.json")
path.write_text(heeler.hotkeys_export(), encoding="utf-8")

result = heeler.hotkeys_import(path.read_text(encoding="utf-8"))
print("Imported", result["imported"], "bindings")
if result["dropped"]:
    print("Unknown command ids:", result["dropped"])
```

## Recover from a restarted bridge

External script.

```python
import time
import heeler

for attempt in range(3):
    try:
        print(heeler.ping())
        break
    except heeler.HeelerError:
        heeler.disconnect_bridge()
        if attempt == 2:
            raise
        time.sleep(1)
```
