# Recovery bundles

Open **File > Catalogs and recovery…**. The dialog has three panes, chosen from the column on the left, the way Preferences and this guide work. **This catalog** shows the one in use, its path, its size, how much of that is thumbnail cache and **Show on disk**, along with New catalog, Open catalog, Move catalog and Import into this one. **Backup and recovery** holds the four controls described below: **Catalog backup…**, **Restore catalog from copy…**, **Recovery bundle…** and **Verify recovery bundle…**. **Catalogs this computer knows** lists the catalogs you have opened, the last forty. Each control says beside it what it does, and the result of the last operation appears under whichever pane you are in, so a job started in one is still reported after you move to another.

## Catalogs this computer knows

This is the longer history, up to forty, not just the ten the File menu offers, with the one in use ticked and any whose file is missing marked. **Switch** opens one. **Remove** takes a single entry off the list and **Clear list** empties it; both forget where a catalog was and leave the database itself untouched, so opening it again puts it back at the top. If you keep a catalog per shoot, this is where you tidy the list.

## Restoring a copy

Never copy a backup over the catalog file by hand. A catalog in use keeps a journal file beside it (`catalog.sqlite-wal`), and a copy placed over the catalog while that journal remains is damaged the next time it opens: the journal belongs to the old file and is applied to the new one. Heeler closes the journal cleanly when it quits, but a crash or a killed process leaves it behind.

Two safe ways back:

- **Restore catalog from copy…** in this dialog closes the catalog with its journal folded in, verifies the copy against its source, renames the current file and any journal beside it with the date rather than deleting them, puts the copy in place and opens it. A copy written by an older Heeler meets the update prompt first, as it would on any open.
- **Open catalog…** on the copy itself switches to it where it lies, journal-free, and leaves the current catalog untouched.

If a catalog does come up damaged, Heeler says so at open, with the journal named as the usual cause, rather than failing later in the session.

## Catalog backup

**Catalog backup…** writes a compact database copy at the location you choose. Every copy, this one, the scheduled ones and the copy the update prompt offers, is verified against the catalog before it takes its name: the same photograph and folder counts, or the copy is refused and named. The count is in the message. It preserves library records, ratings, flags, collections, catalog settings, and export and lens presets. Thumbnails are left out. It does not include the separate graph files containing edits and takes.

Automatic backups are set from the menu in **Preferences > Backup > Catalog backup**: Never, Daily, Weekly, Every two weeks, or Monthly (thirty days), into an existing folder you choose. Heeler checks once at each launch and backs up when at least that many days have passed since the last automatic backup, so Daily means twenty-four hours since the last one rather than a change of date. The first launch after you set a schedule backs up right away. A change to the cadence or folder takes effect at the next launch; **Catalog backup…** in this dialog makes a copy immediately and leaves the schedule alone.

Keep the drive connected and the folder present at launch. A missing folder is reported rather than recreated, so a disconnected drive's path is never rebuilt on the local disk; reconnect it or choose another folder, and the next launch tries again. A failure is shown in a dialog at launch that says what happened and what to do, and in the Console.

Each automatic backup is a new file, `heeler-catalog-<time>.sqlite`, and existing files are never overwritten or removed; clear out old copies yourself when you need the space. A copy that did not finish is left as a `.partial` file, never under a backup's name. A backup folder beside the catalog is allowed, but a copy on the same drive does not protect against that drive failing.

## Recovery bundle

**Recovery bundle…** asks for a new folder name and location, then finishes pending saves for every photograph, session, settings, and presets before capturing the database. A failed save stops the bundle and names the problem. The dialog keeps its controls visible and disabled until the operation finishes.

The bundle contains:

- A consistent catalog database snapshot, without thumbnails.
- Saved graph documents with all their takes, including inactive takes and nested groups. Existing recovery companions are retained alongside them.
- Required baked selection bases and inpaint fills referenced by saved edits. These are retained inputs, not regenerable caches.
- Layer via Copy and Bake Warp pictures referenced by saved edits, while **Keep baked pictures in backups** is on (the default; see below).
- The user preset library, including its folders. Export and lens presets travel in the database.
- A manifest with the bundle schema, catalog schema, Heeler version, original locations, file sizes, SHA-256 checksums, edit counts, and source references.
- An inventory of referenced photographs, File and Catalog node inputs, stack and panorama recipes and their member files. Baked stack or panorama results that are used as inputs are inventoried too.

A trashed photograph is inventoried where its `.trash` folder's index says it is, under the name the index gave it (a second `IMG_1.jpg` in the same trash becomes `IMG_1 (2).jpg`). A trashed stack or panorama keeps its members where they are: they are inventoried in the folder the recipe was made in, not inside `.trash`. A trashed photograph whose file is no longer in `.trash` was removed outside Heeler, since Heeler deletes nothing; the report says how many and in which `.trash` folders as a note, its edits are in the bundle, and it never makes a bundle **Incomplete**. **Edit > Forget Missing Trashed Photos…** takes such photographs out of the catalog once you are done with them; a bundle made before that still holds their edits.

Photographs, recipes, and baked stack or panorama results stay at their recorded paths. Their bytes are **not copied into the bundle**. Keep them in your photograph backup as well. Finish pictures made by Layer via Copy and Bake Warp are copied into the bundle, including pictures used only by an inactive take or preset, unless you turn that off.

### Keep baked pictures in backups

**Preferences > Backup > Keep baked pictures in backups** decides whether recovery bundles carry the pictures Layer via Copy and Bake Warp make. On, the default, a bundle can restore those layers even when the folder Heeler keeps them in is gone; they count as baked inputs in the report. Off, bundles are smaller, but a baked or copied layer whose picture is lost cannot come back.

These pictures are large: a Bake Warp of a whole 24 megapixel frame is about 184 MB, a copied subject a few megabytes. While the preference is on, the bake's dialog says the picture is kept in each recovery bundle, and when the picture is saved the status line says how much it adds, for example "Bake Warp: this picture adds about 184 MB to each recovery bundle (Preferences > Backup)". With it off the bake says nothing about backups.

Off, a bundle records each of these pictures by its path, size and checksum, the way it records photographs, and the report notes how many were left out. They are not required inputs: one that is missing when the bundle is made, verified or restored is a note in the report, not a reason for **Incomplete**, and the rest of the bundle restores. The restored layer points at the picture's old path; if it is not there, the layer's panel says the picture Heeler kept for it is missing and where it was, and **Relink** puts a copy back if you have one. The preference applies to bundles made after you change it; a bundle already made keeps what it has. The inventory records external sources' paths and checksums so recovery can detect a missing or changed source. Missing sources produce an **Incomplete** result that counts them and lists their paths (see Verify recovery bundle below), while preserving the edit files that are available.

Previews, proxies, thumbnails, depth rasters, and matte rasters are named as optional caches in the manifest and left out. Heeler rebuilds those caches when needed and their models are available. Baked selection bases and chosen inpaint fills are preserved separately because their saved pointers cannot regenerate the result. The bundle captures the active catalog and the app's saved graph and preset folders; other catalog databases require their own backup.

The bundle is written under a unique `.partial` staging name, synchronized, and renamed to the chosen name only after all files and the manifest are written. An existing destination is refused. A failed write leaves its `.partial` staging folder in place and names it in the error. It holds copies of files that still live in Heeler's own folders, the verifier refuses it, and removing it is yours to do, since Heeler deletes nothing in a folder you chose. No photograph is changed.

## Verify recovery bundle

**Verify recovery bundle…** asks for a bundle folder. It works offline and reads the bundle and original files without restoring or modifying them. The result lists photographs, graphs, takes, presets, referenced assets, required baked inputs, and the writing app's version, and ends with any notes, such as Finish pictures left out by **Keep baked pictures in backups**. **Complete** means the bundled files pass their size and checksum checks, the database passes its integrity check, edit counts and references agree, and all required originals still match their recorded checksums. **Incomplete** lists every problem on its own line:

- **N original files are missing**: photographs or other sources the edits refer to are not at their recorded paths. The line counts them, names a drive that is not mounted (for example `/Volumes/DATA`), and gives the first three paths; the full list follows under **Missing originals**. The edits themselves are in the bundle, and it restores once the files are back at those paths, usually by connecting the drive. Making a bundle while a drive is unplugged reports the same line and still writes a whole bundle. When the catalog also holds a file with the same name somewhere else, a note names it: if that is the photograph, moved outside Heeler, moving it back to the recorded path brings its edits back to it.
- **A file's checksum or size differs**, or **a file is listed in the manifest but not in the bundle**: the bundle itself was changed or damaged after it was made.
- **The bundle holds files its manifest does not list**: something wrote into the bundle folder; the line names them. Move them out and verify again.

Files the operating system or a file browser puts into any folder it shows (macOS's `.DS_Store` and `._` files, a folder icon's `Icon` file, Spotlight and Trash folders, Windows' `Thumbs.db` and `desktop.ini`) are not part of the bundle: opening a bundle in a file browser never makes it Incomplete, and a new bundle leaves such files in app data out.

The result is selectable text, and the copy button beside it copies all of it, every problem and path, for a message or a support request. Both runs are also written to the Console with each problem and each missing original on its own line. Unknown schemas, unsafe paths, and symbolic links inside the bundle are refused.

The same verifier runs from a terminal, with no app window, service, model, or app-data migration:

```sh
heeler-desktop recovery verify /path/to/edits.heeler-recovery
```

It prints a JSON report and returns exit status 0 for complete, 1 for incomplete or unreadable, and 2 for incorrect arguments.

## Restore into empty app data

Quit Heeler before restoring. Keep originals at their recorded locations and create an empty destination directory. Run:

```sh
heeler-desktop recovery restore /path/to/edits.heeler-recovery /path/to/empty-app-data
```

Restore verifies the whole bundle and its referenced originals before copying the database, graphs, and presets. It refuses a nonempty destination and never overwrites an existing file. The restored database is named `catalog.sqlite`, so Heeler uses it by default when this directory is used as its app-data directory. When required baked inputs are restored, their files live under the new app data. For baked selection and inpaint inputs, a custom model-store preference is reset to the default so Heeler finds those inputs there. Finish image paths in saved graphs, takes, nested groups, presets and catalog entries are updated to their copies inside the new app data; their old files are untouched. Model weights are not included. An interrupted restore may leave copied files in the destination; retain those files and retry into another empty directory. The recovery bundle stays unchanged.

Recovery bundles have no schedule. Each bundle uses the location you choose, and **Keep baked pictures in backups** is their one preference. Scheduled catalog backups remain database backups.
