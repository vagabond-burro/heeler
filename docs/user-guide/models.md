# Downloaded models

The smart selection tools, the depth tools, Noise Reduction's Model method and the assistant's picture reader run machine-learning models. None of them ships in the installer: each is downloaded only when you ask, verified against a checksum pinned in the app before it is trusted, and kept in Heeler's data folder. Every model runs on your machine; nothing in your photographs is sent anywhere.

## The models

| Model | Used by | Size |
|---|---|---|
| Segment Anything 2.1 (Tiny) | Smart selection: Click, Subject and Sky | 156 MB |
| Segment Anything (MobileSAM) | Smart selections made before Heeler 2026.7 | 37 MB |
| BiRefNet dynamic | The subject one-shot matte | 972 MB |
| LaMa | Remove and the Finish Fill layer | 208 MB |
| ViTMatte | Selection Polish | 104 MB |
| Depth Anything V2 Small | Fog, Depth Lighting, Depth of Field, depth masks and depth-range selections | 99 MB |
| MoGe-2 ViT-S | Depth Lighting's Model normals (optional) | 141 MB |
| SCUNet | Noise Reduction's Model method | 77 MB |
| Florence-2 base | Select by text, and the assistant: what is in the photograph and where (optional) | 970 MB |

Their licenses and origins are on the [open-source page](legal/open-source.md).

BiRefNet Lite (224 MB) was the subject matte before BiRefNet dynamic. It is no longer offered, but a copy already installed stays listed in Preferences, **Models** until you remove it: it answers Subject until BiRefNet dynamic is installed, and it recomputes the mattes of selections made with it (see [The Subject matte](finish/masks-selections.md#the-subject-matte)).

Florence-2 is Microsoft's, under the MIT license, packaged for ONNX by the Hugging Face onnx-community and trained on FLD-5B, Microsoft's own dataset. The assistant works without it, and you download it from Preferences, **Assistant** or **Models** if you want the assistant to know what is in the picture; the Smart tool's **Select by text** field asks for it the first time you use it (see [Select by text](finish/masks-selections.md#select-by-text)).

## Installing

A tool that needs a model it does not have shows a card naming the model, its size, its license and where it comes from, with a **DOWNLOAD** button. Nothing is fetched until you press it.

Preferences, **Models** lists every model with its status and version. A model not yet installed has an **INSTALL** button there, which opens the same card, so you can fetch a model ahead of a shoot rather than at the moment a tool first asks. **REMOVE** frees a model's disk space; its tool asks again the next time it needs it.

Every model has two sources: where its authors published it, and a mirror of the same files on Vagabond Burro's own release page. The download tries the first and falls back to the second; the checksum is the same, so it does not matter which one answered.

## Updating

**CHECK FOR MODEL UPDATES** asks a vetted model list published with Heeler's releases whether newer weights exist for any model installed here. Nothing is followed from the models' own upstream pages automatically: an entry reaches the list only after Vagabond Burro has run those weights through Heeler's tests. A model with newer weights is listed with both versions, the download size and a note, and **UPDATE** downloads it over the copy in place through the same checked path. Before the first release that carries the list, the check says so.

## Where they live

The **Location** row shows the folder the models are kept in and lets you choose another, on an external drive for instance. With models already installed, choosing a new folder offers to move them. The rasters the models compute (depth planes, mattes, the noise model's answers) are caches, kept beside the catalog's other caches and cleared from Preferences, Storage; the models themselves are not touched by that.
