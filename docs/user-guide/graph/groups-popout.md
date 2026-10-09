# Groups, backdrops, and pop-out view

Groups make a graph region reusable; backdrops organize without changing processing; pop-out view gives the graph its own window.

## Groups

Select two or more nodes and choose **Save selection as group…**. Enter a name and description. The group becomes one card with internal image and mask connections preserved.

Double-click a group to open it. Its internal nodes and wires replace the outer graph until you click the leave-group control. Published parameters remain available from the outer Inspector, while the full controls remain inside.

To keep a group for other graphs, right-click it and choose **Save as Recipe…**; it then lists in the node palette with the built-in recipes (see [Node recipes](recipes.md)).

The Finish layer stack is itself a group. Opening it reveals the compositing nodes created by layers, masks, clipping, and effects: each layer's content, its effects and its blend, and each layer's mask wired to its blend's mask port with a dashed mask wire. Everything Finish makes lives in this group. The photograph the masks read (after the crop, the lens correction and the warps) comes in on the group card's second input, and a Depth mask's depth map on its depth input; inside, each mask takes them from there. To shape a layer's mask in the graph, drag a **Morphology** or a **Guided Filter (Mask)** onto the mask's wire inside the group: it renders at Fit, 1:1 and in the export, and the layer's mask buttons, brush and eye keep working on the mask behind it. **Remove layer mask** leaves such a node in the group but unwires it from the layer.

Press `Cmd`+`G` (`Ctrl`+`G` on Windows) to open the same dialog for the current selection.

For reusable groups with published controls, see [Node recipes](recipes.md#making-your-own).

## Backdrops

Choose **Add backdrop** to place a labeled colored rectangle around selected nodes or at the pointer. Drag or resize it to organize a branch. Cycle its color or delete it with the controls on the backdrop. A backdrop does not connect nodes or change rendering.

Use backdrops for stages, alternatives, notes, or ownership. Use groups when the structure should collapse, move as a reusable operation, or expose published controls.

## Auto-arrange

**Auto-arrange** lays nodes from left to right so wires do not double back. It changes graph positions, not the image result or connections. It is useful after inserting recipes or opening an older graph with crowded nodes.

## Pop out and return

Click the pop-out icon at the bottom of the graph's left toolbar. The node canvas opens in a separate window and the main window gives the released space to the image viewport. Every popped-out window, the graph, the spectrums, Color Bend and the tool windows, carries the same dock icon, an arrow coming home into a window; click it to put the contents back in the main window.

The Inspector can live in either window. Its narrow rail marks the window that does not currently own it. Returning the graph or Inspector preserves graph selection, open group, positions, and viewport state.

The [Window menu](../menus.md#window) can bring the graph and other windows back into the main window.

> **Screenshot placeholder:** Native dual-window view showing the popped-out Graph and the Inspector rail.
