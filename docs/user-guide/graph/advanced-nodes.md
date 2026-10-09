# Advanced graph tools

Use these tools when you need to process channels, masks, or depth directly. They are graph-only: there is no matching Develop section or Finish layer.

## Add and connect a tool

1. Open **Graph** and press **Shift+Space** to open **Find a Node**.
2. Type the tool's name and choose it. The Inspector shows its actual starting values.
3. Connect the required image or field inputs. You can drag a wire from either end; compatible ports light up.
4. Select the card to change its controls. Use **Probe** to inspect its output, then close the probe badge to return to the finished photograph.
5. Use **Edit > Undo** (**Cmd+Z**, **Ctrl+Z** on Windows) to undo an addition, connection, or control change. The card's switch bypasses it while retaining settings; **Reset** restores its defaults.

The eleven additions are listed below. Picture and mask variants share a family but are separate choices in the palette; Chroma Key and its Despill companion are separate nodes too.

| Tool | Menu path | Use it for | Important limit |
| --- | --- | --- | --- |
| Morphology | Masking > Mask Tools > Morphology | Shrink, grow, open, or close any mask | The window stops at the frame. |
| Guided Filter | Detail > Blur & Smooth > Guided Filter | Smooth a picture while keeping a guide's edges | An unwired guide uses the picture itself. |
| Guided Filter (Mask) | Masking > Mask Tools > Guided Filter (Mask) | Refine a mask against a picture | Wire the mask to the diamond and the guide to the image input. |
| Edge Field | Masking > Mask Tools > Edge Field | Extract edge strength as a mask | Scale is capped at 64 photograph pixels. |
| Alpha Association | Utility > Channels > Alpha Association | Extract, replace, premultiply, or unpremultiply alpha | Replace changes alpha; it does not multiply RGB. |
| Technical Soft Clip | Color > Tone > Technical Soft Clip | Roll values toward a chosen ceiling | Choose **Brightest channel** (hue kept) or **Each channel** deliberately. |
| Median / Percentile | Detail > Blur & Smooth > Median / Percentile | Remove local specks without ordinary blur | Radius is capped at 200 photograph pixels; ranking is quantized. |
| Median / Percentile (Mask) | Masking > Mask Tools > Median / Percentile (Mask) | Remove pinholes or vary a mask's local coverage | Values are mask coverage, not image color. |
| Signed Distance Field | Masking > Mask Tools > Signed Distance Field | Make measured falloffs inside and outside a mask | The ramp stops at Max distance; distances are measured between pixel centers. |
| Chroma Key | Masking > Range Masks > Chroma Key | Make a screen matte | Despill is a separate node, **Color > Color > Chroma Key (Despill)**. |
| Chroma Key (Despill) | Color > Color > Chroma Key (Despill) | Remove screen color from subject edges | It changes color, not transparency. |
| Normals from Depth | Detail > Depth > Normals from Depth | Turn depth into an editable normal map | The result is approximate relief, not calibrated 3D geometry. |
| Color Transform | Utility > Color Space > Color Transform | Convert between declared color spaces | Default From is Linear Rec. 709; restore working space before ordinary edits. |
| Displacement Map | Source > Geometry > Displacement Map | Move image pixels using X and Y fields | Earlier masks, strokes, and depth are not displaced with the picture. |

For the numerical conventions and defaults, use the [node reference](nodes/README.md). For complete editable combinations, use [Node recipes](recipes.md).

## Keep spatial inputs together

A crop, lens correction, or warp changes the frame that masks read. Connect a tool's guide and target from the same stage when their pixels must correspond. **Displacement Map** changes only its picture input: a mask or depth plane made before it does not follow that displacement. Build a new range or key mask from the displaced output, or explicitly displace related image data in a matching branch.

## Read data without changing its meaning

A mask wire can also carry depth or another single-channel measurement. A normal map is an image whose colors encode directions. Do not apply a color look to a data map unless you intend to change the measurement. **Depth Map** gives farness, 0 near and 1 far; the Develop depth view displays near white and far black, while an exported depth layer writes near black and far white.
