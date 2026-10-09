//! The catalog: SQLite-backed image index for the library system.
//!
//! Lives at `<project>.heelerproj/catalog.sqlite`. Owns what the library
//! panel and filmstrip need: watched folders, the image file index, ratings
//! and pick/reject flags, collections (an image can belong to many), and the
//! thumbnail cache. Edit data (graphs, versions) stays in the project
//! manifest and graph files; the two stores share image ids.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("image '{0}' not found in catalog")]
    ImageNotFound(String),
    #[error("collection '{0}' not found")]
    CollectionNotFound(String),
    #[error("a collection named '{0}' already exists")]
    CollectionExists(String),
    #[error("rating {0} is out of range (0 to 5)")]
    InvalidRating(i64),
    #[error("catalog schema version {0} is newer than this build supports")]
    SchemaVersion(i64),
    #[error("catalog schema version {0} is older than this build reads; open it with the Heeler that wrote it")]
    SchemaTooOld(i64),
    #[error("{0} already exists; a backup never writes over a file")]
    BackupExists(String),
    #[error("the copy at {path} holds {copy_images} photographs in {copy_folders} folders, but the catalog holds {images} in {folders}; the copy was left where it is and nothing else changed")]
    BackupIncomplete { path: String, images: i64, folders: i64, copy_images: i64, copy_folders: i64 },
    #[error("'{0}' is damaged: SQLite reports {1}. A copy placed over a live catalog by hand, with the live catalog's -wal journal left beside it, is the usual cause: the stale journal is applied to the copy on the next open. Open a copy with Open Catalog, or restore it with Restore Catalog from Copy, rather than replacing the file")]
    Malformed(String, String),
    #[error("'{0}' is not a Heeler catalog")]
    NotACatalog(String),
    /// A long operation the user stopped: the string names whatever
    /// partial file was left in place so the message can too. Nothing
    /// is ever deleted on a cancel.
    #[error("canceled; {0}")]
    Cancelled(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flag {
    None,
    Pick,
    Reject,
}

impl Flag {
    fn as_str(self) -> &'static str {
        match self {
            Flag::None => "none",
            Flag::Pick => "pick",
            Flag::Reject => "reject",
        }
    }

    fn parse(s: &str) -> Flag {
        match s {
            "pick" => Flag::Pick,
            "reject" => Flag::Reject,
            _ => Flag::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbKind {
    /// Fast first pass from the file's embedded preview.
    Embedded,
    /// Rendered through the image's current graph; reflects edits.
    Rendered,
}

impl ThumbKind {
    fn as_str(self) -> &'static str {
        match self {
            ThumbKind::Embedded => "embedded",
            ThumbKind::Rendered => "rendered",
        }
    }

    fn parse(s: &str) -> ThumbKind {
        if s == "rendered" {
            ThumbKind::Rendered
        } else {
            ThumbKind::Embedded
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageRecord {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub folder_id: Option<i64>,
    pub rating: u8,
    pub flag: Flag,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub added_at: i64,
    /// whether the user has edited this image (drives the thumb badge)
    pub edited: bool,
    /// the link group this image belongs to, if any: edits to any member
    /// are mirrored onto the others
    pub link_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionRecord {
    pub id: i64,
    pub name: String,
    /// References a collection graph file when the collection has a look.
    pub graph_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderSummary {
    pub id: i64,
    pub path: String,
    pub last_opened: i64,
    pub image_count: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionSummary {
    pub id: i64,
    pub name: String,
    pub graph_id: Option<String>,
    pub image_count: i64,
}

/// What a catalog is made of. Sizes are bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogStats {
    pub images: i64,
    pub folders: i64,
    pub collections: i64,
    pub thumbnails: i64,
    pub hidden: i64,
    /// the cached thumbnail blobs, which are regenerable
    pub thumbnail_bytes: i64,
    pub total_bytes: i64,
}

impl CatalogStats {
    /// What a backup would cost with the thumbnails left out: the part
    /// of the catalog nobody can rebuild.
    pub fn irreplaceable_bytes(&self) -> i64 {
        (self.total_bytes - self.thumbnail_bytes).max(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupReport {
    pub path: String,
    pub bytes: u64,
    pub images: i64,
    pub folders: i64,
    pub thumbnails_dropped: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub folders_added: i64,
    pub images_added: i64,
    pub collections_added: i64,
    /// already known to this catalog, so left exactly as they were
    pub images_skipped: i64,
}

/// Filter for `list_images`. All fields optional and combined with AND.
#[derive(Debug, Default, Clone)]
pub struct Filter {
    pub min_rating: Option<u8>,
    pub flag: Option<Flag>,
    pub extension: Option<String>,
    pub folder_id: Option<i64>,
    pub collection_id: Option<i64>,
    /// Only images carrying this keyword (case folds in the table).
    pub keyword: Option<String>,
    /// Hidden images are left out unless something explicitly asks for
    /// them, and the default is what every existing caller gets. The one
    /// caller that wants them is the count behind "Recover Hidden": if
    /// hidden images could leak into an ordinary listing through a
    /// forgotten flag, hiding would not mean anything.
    pub include_hidden: bool,
}

/// Extensions the library indexes. The raw entries mirror heeler-io's
/// RAW_EXTENSIONS, and a test there fails if the two drift: every one of
/// them developed in the raw.pixls.us corpus. GoPro .gpr is intentionally
/// absent: LibRaw cannot decode VC-5 without GoPro's separate SDK
/// (Apache-2.0, a future vendoring candidate), so listing them would only
/// produce broken entries. Sigma .x3f is absent for the same reason,
/// LibRaw dropped Foveon.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    // HEIC only where the OS supplies the codec: macOS ImageIO, and
    // Windows WIC when Microsoft's HEVC and HEIF extensions are installed
    // (the owner's zero-patent-exposure call, see the format research
    // doc). Listing it on Linux would index files the decoder cannot open.
    // A Windows box WITHOUT the extensions indexes them and then reports
    // them unsupported, which is the honest failure: the file is a
    // photograph, the machine is one Store install away from opening it,
    // and hiding it would say neither.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    "heic",
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    "heif",
    "dng", "jpg", "jpeg", "png", "tif", "tiff", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2",
    // Pentax, Samsung, Hasselblad, Phase One and Leaf, Epson, Nikon
    // Coolpix, early Sony; then Canon CIFF, Leica and Panasonic compacts,
    // Olympus high-res originals, Minolta, Kodak, Mamiya, Sony pixel
    // shift, Sinar. Each was invisible until 2026-09-08 although the
    // loader already developed it.
    "pef", "srw", "3fr", "iiq", "erf", "nrw", "srf", "sr2",
    "crw", "rwl", "raw", "ori", "fff", "mrw", "kdc", "dcr", "mos", "mef", "arq", "sti", "mdc",
    // OpenEXR: scene-linear renders and HDR merges, read for their beauty and, behind
    // it, their render passes.
    "exr",
    // A stack is a recipe, not a rendered file: a small manifest naming
    // the frames it merges and how. Indexing it like any other image is
    // what makes ratings, flags, filters, folder counts and session
    // restore work on stacks without a line of special-casing.
    STACK_EXTENSION,
    LEGACY_STACK_EXTENSION,
    PANO_EXTENSION,
];

/// Extension of the stack manifest. Deliberately not a rendered TIFF:
/// keeping the recipe means the merge stays editable forever, and the
/// user exports a real file when they actually want one.
pub const STACK_EXTENSION: &str = "stack";

/// What stacks were called before. Still read, never written: the
/// owner had already made stacks by the time the name got shorter,
/// and a rename is no reason to lose them from the library.
pub const LEGACY_STACK_EXTENSION: &str = "heelerstack";

/// Extension of the panorama manifest. Same idea as a stack: a recipe
/// naming its frames, not a baked result, so the stitch stays editable
/// and the source frames stay where they are.
pub const PANO_EXTENSION: &str = "pano";

pub fn is_pano(ext: &str) -> bool {
    ext.eq_ignore_ascii_case(PANO_EXTENSION)
}

pub fn is_stack(ext: &str) -> bool {
    ext.eq_ignore_ascii_case(STACK_EXTENSION) || ext.eq_ignore_ascii_case(LEGACY_STACK_EXTENSION)
}

pub fn is_supported_extension(ext: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

/// AppleDouble sidecars (`._IMG_0001.cr2`) carry the image's extension
/// but hold resource-fork bytes, not pixels. macOS writes them on FAT,
/// exFAT, and SMB volumes, which is exactly what camera cards are.
fn is_apple_double(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("._"))
}

/// True for `.trash` and its dot-prefixed neighbors.
fn is_dot_dir(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'))
}

/// Recursively finds supported image files under `dir`, sorted for
/// deterministic results. Pure helper: no database involved, the app layer
/// pairs discoveries with project image ids. Reserved for explicit import
/// flows; interactive browsing uses the shallow variant so opening a huge
/// tree never walks it all.
pub fn discover_files(dir: &Path) -> Result<Vec<PathBuf>, CatalogError> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    // Symlinked folders are a legitimate way to file a library (a
    // symlink to the other drive), so the walk follows them, but a
    // symlink that points at its own ancestor would walk forever.
    // Remember each directory's canonical path and visit it once.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(current) = stack.pop() {
        if let Ok(canonical) = std::fs::canonicalize(&current) {
            if !seen.insert(canonical) {
                continue;
            }
        }
        for entry in std::fs::read_dir(&current)? {
            let path = entry?.path();
            if path.is_dir() {
                // `.trash` is the reason this check exists: the folder
                // beside the images is still on the disk the import
                // walks, and a recursive scan that found it would import
                // the very photographs the user just took out of the
                // library. Every dot-directory is skipped, not just that
                // one, because none of them is somewhere a photographer
                // filed their work on purpose.
                if !is_dot_dir(&path) {
                    stack.push(path);
                }
            } else if !is_apple_double(&path)
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(is_supported_extension)
                    .unwrap_or(false)
            {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Supported image files directly inside `dir`, no recursion. This is what
/// interactive folder browsing scans: subfolders are listed, not walked.
pub fn discover_files_shallow(dir: &Path) -> Result<Vec<PathBuf>, CatalogError> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && !is_apple_double(&path)
            && path
                .extension()
                .and_then(|e| e.to_str())
                .map(is_supported_extension)
                .unwrap_or(false)
        {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

/// Immediate subdirectories of `dir`, hidden ones skipped, sorted. The
/// folder browser shows these for navigation without scanning them.
pub fn list_subfolders(dir: &Path) -> Result<Vec<PathBuf>, CatalogError> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let hidden = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(true);
        if path.is_dir() && !hidden {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

// The schema version this build writes and migrates to (26.3). Every
// catalog open passes the caller's upgrade gate before reaching
// `open_existing`: a catalog below this version is refused until the
// user has had the backup choice, because `open` migrates in place and
// that cannot be undone. `pending_upgrade` is the gate's read-only
// probe, `snapshot_unopened` its pre-update copy, and `written_by`
// signs every file this build touches. Bump this only with a matching
// entry in MIGRATIONS; the constant is the array's length.
const SCHEMA_VERSION: i64 = 18;

const MIGRATION_V1: &str = "
CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE
);
CREATE TABLE images (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    extension TEXT NOT NULL,
    folder_id INTEGER REFERENCES folders(id),
    rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    flag TEXT NOT NULL DEFAULT 'none' CHECK (flag IN ('none','pick','reject')),
    width INTEGER,
    height INTEGER,
    added_at INTEGER NOT NULL
);
CREATE INDEX idx_images_folder ON images(folder_id);
CREATE INDEX idx_images_rating ON images(rating);
CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    graph_id TEXT
);
CREATE TABLE collection_members (
    collection_id INTEGER NOT NULL REFERENCES collections(id),
    image_id TEXT NOT NULL REFERENCES images(id),
    PRIMARY KEY (collection_id, image_id)
);
CREATE TABLE thumbnails (
    image_id TEXT PRIMARY KEY REFERENCES images(id),
    kind TEXT NOT NULL CHECK (kind IN ('embedded','rendered')),
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);
";

/// v2: folders remember when they were last opened, so the library panel
/// can list recents first and the app can restore the last session.
const MIGRATION_V2: &str = "
ALTER TABLE folders ADD COLUMN last_opened INTEGER NOT NULL DEFAULT 0;
";

/// v3: thumbnails cached before EXIF orientation support were stored
/// unrotated; drop the cache once so they rebuild corrected.
const MIGRATION_V3: &str = "
DELETE FROM thumbnails;
";

/// v4: images remember whether the user actually edited them, so the
/// library's folder shortlist can rank by where work happened.
const MIGRATION_V4: &str = "
ALTER TABLE images ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
";

/// v5: small key-value store for session state (tree root, position) so
/// the library resumes exactly where the user left off.
const MIGRATION_V5: &str = "
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// v6: folders remember when the user last *chose* them, as opposed to
/// merely walking into them. The library's shortlist is a jump list of
/// places the user deliberately opened, the way an editor lists recent
/// projects, and browsing the tree should not fill it up.
const MIGRATION_V6: &str = "
ALTER TABLE folders ADD COLUMN picked_at INTEGER NOT NULL DEFAULT 0;
";

/// v7: an image can be hidden from the catalog without being forgotten.
///
/// Hiding is a flag and nothing else, deliberately. The rating, the flag,
/// the edited mark and the saved graph all stay exactly where they are,
/// so unhiding gives back the photograph the user had rather than a
/// stranger with the same filename. Deleting from disk is the only
/// operation in the app that destroys metadata, and it says so twice.
const MIGRATION_V7: &str = "
ALTER TABLE images ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_images_hidden ON images(hidden);
";

/// v8: the camera data, cached.
///
/// The owner wants a column view over a whole folder, and reading EXIF
/// out of four thousand RAW files every time the panel opens is four
/// thousand file opens for data that has not changed since the shutter
/// fired. The same bargain the thumbnail cache makes, for the same
/// reason, and it rebuilds from the files if it is ever thrown away.
///
/// Every column is nullable because every one of them is genuinely
/// optional: a scan has no aperture, a render has no camera.
const MIGRATION_V8: &str = "
CREATE TABLE exif (
    image_id TEXT PRIMARY KEY REFERENCES images(id),
    camera TEXT,
    lens TEXT,
    shot_at TEXT,
    iso INTEGER,
    aperture REAL,
    shutter TEXT,
    focal REAL,
    exposure_bias REAL,
    artist TEXT,
    copyright TEXT,
    read_at INTEGER NOT NULL
);
CREATE INDEX idx_exif_shot_at ON exif(shot_at);
";

/// v9: thumbnails cached at the old 240 pixel edge, dropped once.
///
/// The panel is draggable now and scales one bitmap rather than asking for
/// a new one per width, so thumbnails are rendered at twice the size. An
/// old one stretched to the new panel is a soft, blocky version of a
/// picture that is sitting right there on disk, and the same one-line
/// answer worked when orientation support landed at v3.
const MIGRATION_V9: &str = "
DELETE FROM thumbnails;
";

/// v10: camera data read before RW2 files could be read at all.
///
/// The reader required the TIFF magic to be 42 and Panasonic writes 0x55,
/// so every RW2 came back with nothing, and nothing is cached the same way
/// a real answer is: the point of the cache is not re-reading a file whose
/// metadata has not changed since the shutter fired. Which means fixing the
/// reader fixes nothing until the empty rows go.
///
/// Cheap to throw away, since it rebuilds from the files themselves.
const MIGRATION_V10: &str = "
DELETE FROM exif;
";

/// v11: keywords. Free-text terms on photographs ("wedding",
/// "detail-shots"), the tagging half of what the gallery-tool refugees
/// miss. NOCASE throughout: "Wedding" and "wedding" are one keyword,
/// because a search that treats them as two is a search that lies.
const MIGRATION_V11: &str = "
CREATE TABLE keywords (
    image_id TEXT NOT NULL REFERENCES images(id),
    keyword TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (image_id, keyword)
);
CREATE INDEX idx_keywords_keyword ON keywords(keyword COLLATE NOCASE);
";

/// v12: same story as v3, one format later. Thumbnails of plain JPEGs
/// (phone photos) cached before EXIF orientation reached the plain-file
/// decode paths were stored sideways; drop the cache once so they
/// rebuild standing up.
const MIGRATION_V12: &str = "
DELETE FROM thumbnails;
";

/// v13: trashed, which is not the same thing as hidden.
///
/// "The only files that can be deleted are stacked and
/// stitched images." Move to Trash renames a photograph into a `.trash`
/// folder beside it, and this column is how the library knows to stop
/// showing it. It could not reuse `hidden`: hiding leaves the file
/// where it is, so "Recover Hidden" on a folder would have resurrected
/// a row whose photograph had moved out from under it. Two different
/// states that both mean "not in the library" need two different
/// columns, or the recovery for one silently corrupts the other.
///
/// The row itself survives, rating, flag, keywords and edited mark
/// intact, because the move is a rename and Put Back is the rename
/// going the other way. Nothing here is destroyed, so nothing here
/// needs re-earning.
const MIGRATION_V13: &str = "
ALTER TABLE images ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_images_trashed ON images(trashed);
";

/// v14: which EXIF reader wrote each cached reading.
///
/// A reading is a pure function of the file AND the reader, and only
/// the file half was keyed. Every parser improvement (CR3 support, the
/// Panasonic lens name) left records cached before it serving the old
/// reader's blind spots forever; the empty-record re-read rule caught
/// total emptiness but not a record with focal and aperture and a
/// fossilized None where the lens belongs. The default 0 marks every
/// existing row as written by an unknown, older reader, so each heals
/// on its next view.
const MIGRATION_V14: &str = "
ALTER TABLE exif ADD COLUMN reader INTEGER NOT NULL DEFAULT 0;
";

/// v15: a folder can be hidden from the library without being forgotten
/// (2026-09-08: a folder browsed into by mistake "just sits there in
/// your folder list"). Hidden is a flag on the folder row: every image
/// row, rating, keyword and collection membership under it stays, and
/// browsing to the folder again clears the flag. Flushing, the other
/// command that day asked for, is not a flag: it removes the rows.
const MIGRATION_V15: &str = "
ALTER TABLE folders ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
";

/// Linked photographs (2026-09-09: "Select a bunch and select to link
/// them. Then any edits applied to one of the linked applies to the
/// others"). One group id per image, NULL when unlinked; the group is
/// the whole relation, so linking is symmetric and unlinking one
/// photograph leaves the rest linked.
const MIGRATION_V16: &str = "
ALTER TABLE images ADD COLUMN link_group TEXT;
";

/// The folder listing (`list_images` with a folder, and `list_trashed`)
/// filters by folder and orders by file name, and the only index on
/// images(folder_id) left SQLite sorting every folder's rows on each
/// open. A composite index answers the listing in order. Also the first
/// schema change since the upgrade gate was built (26.3 Phase 1), so
/// the first launch of 26.3 is where the backup prompt is exercised
/// (2026-09-19: "right now I can't verify if it works").
const MIGRATION_V17: &str = "
CREATE INDEX idx_images_folder_name ON images(folder_id, file_name);
";

/// v18: the photograph's size as a full decode found it. The header's
/// `width` and `height` stay what the listing and the thumbnails read,
/// read at scan time without decoding (31 to 36 MB a RAW); the decode
/// can differ by a margin the header leaves out (the jaguar's header
/// says 4000 on the short side, the decode 4016), and the pixel dials
/// of a reduced preview are scaled by the decoded size once one exists
/// (the groups-scale review's R7). Keyed by the source key the decode
/// ran under, which names the develop options and the file's length and
/// modified time: another option or a replaced file is another row.
const MIGRATION_V18: &str = "
CREATE TABLE decoded_dims (
    image_id TEXT NOT NULL REFERENCES images(id),
    source_key TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    PRIMARY KEY (image_id, source_key)
);
";

/// Every migration in order, and the only list of them.
///
/// Both the on-disk path and the in-memory one walk this. They used to
/// name the migrations separately, which drifted the moment one was added:
/// every test then ran against a schema one version behind the real thing,
/// and the failure looks exactly like the new feature being broken.
/// `SCHEMA_VERSION` is the length of this array, so the two cannot
/// disagree either.
const MIGRATIONS: [&str; SCHEMA_VERSION as usize] = [
    MIGRATION_V1,
    MIGRATION_V2,
    MIGRATION_V3,
    MIGRATION_V4,
    MIGRATION_V5,
    MIGRATION_V6,
    MIGRATION_V7,
    MIGRATION_V8,
    MIGRATION_V9,
    MIGRATION_V10,
    MIGRATION_V11,
    MIGRATION_V12,
    MIGRATION_V13,
    MIGRATION_V14,
    MIGRATION_V15,
    MIGRATION_V16,
    MIGRATION_V17,
    MIGRATION_V18,
];

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct Catalog {
    conn: Connection,
    /// The schema span this open migrated across, or None when the
    /// file was already current (or freshly made).
    migrated: Option<(i64, i64)>,
}

/// Where a backup is written while it is incomplete: the final name
/// plus ".partial", beside it.
pub fn partial_backup_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".partial");
    dest.with_file_name(name)
}

/// The shared body of every catalog backup: VACUUM the connection's
/// database into a ".partial" file, drop the thumbnails unless asked to
/// keep them, rename into place. Never overwrites: a taken name is
/// refused, not replaced. The source connection may be read-only
/// (snapshot_unopened's is); VACUUM INTO writes only the target.
/// This build's schema, for callers outside the crate.
pub fn schema_version() -> i64 {
    SCHEMA_VERSION
}

/// The (images, folders, collections) a catalog file holds, read through
/// a read-only connection: no migration, no journal written.
pub fn counts_unopened(path: &Path) -> Result<(i64, i64, i64), CatalogError> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| CatalogError::NotACatalog(path.display().to_string()))?;
    let count = |table: &str| -> Result<i64, CatalogError> {
        Ok(conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
    };
    Ok((count("images")?, count("folders")?, count("collections")?))
}

/// Snapshot a restore source without opening it for writing or migrating it.
/// The caller owns the final rename and retains an interrupted copy for inspection.
pub fn restore_copy_unopened(source: &Path, partial: &Path, tick: Option<VacuumTick>) -> Result<(), CatalogError> {
    let source = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    std::fs::OpenOptions::new().write(true).create_new(true).open(partial)?;
    let sample = restore_sample(&source)?;
    let version: i64 = source.pragma_query_value(None, "user_version", |r| r.get(0))?;
    vacuum_statement_watched(&source, partial, tick.as_ref())?;
    let copy = Connection::open_with_flags(partial, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let copied_version: i64 = copy.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != copied_version || sample != restore_sample(&copy)? {
        return Err(CatalogError::Malformed(partial.display().to_string(),
            "restore verification failed: schema version, ratings, flags or collection membership differ".into()));
    }
    if tick.as_ref().is_some_and(|tick| !tick(partial)) {
        return Err(CatalogError::Cancelled(format!("the unfinished copy was left at {}", partial.display())));
    }
    Ok(())
}

fn restore_sample(conn: &Connection) -> Result<Vec<(String, i64, String, Vec<i64>)>, CatalogError> {
    let mut images = conn.prepare("SELECT id, rating, flag FROM images ORDER BY id LIMIT 64")?;
    let mut members = conn.prepare("SELECT collection_id FROM collection_members WHERE image_id = ?1 ORDER BY collection_id")?;
    let mut sample = Vec::new();
    for row in images.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))? {
        let (id, rating, flag) = row?;
        let collections = members.query_map([&id], |r| r.get(0))?.collect::<Result<Vec<i64>, _>>()?;
        sample.push((id, rating, flag, collections));
    }
    Ok(sample)
}

/// The -wal journal SQLite keeps beside a catalog in WAL mode.
pub fn journal_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(path.with_file_name(format!("{name}-wal")))
}

/// A progress-and-cancel probe for a backup: called with the partial
/// file's path while VACUUM INTO runs, and once more after the copy is
/// verified but before it takes the backup's name. Returning false
/// cancels: the copy is interrupted or stopped, the partial is left
/// where it is and named in the `Cancelled` error, and nothing else
/// changes. Arc because the connection's progress handler owns its
/// closure.
pub type VacuumTick = std::sync::Arc<dyn Fn(&Path) -> bool + Send + Sync>;

/// A should-stop flag for a long statement: polled between an import's
/// statements and, through the connection's progress handler, inside
/// them. Arc because the handler owns its closure.
pub type StopFlag = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

fn vacuum_into(
    conn: &Connection,
    dest: &Path,
    include_thumbnails: bool,
) -> Result<BackupReport, CatalogError> {
    vacuum_into_watched(conn, dest, include_thumbnails, None)
}

fn vacuum_statement_watched(conn: &Connection, partial: &Path, tick: Option<&VacuumTick>) -> Result<(), CatalogError> {
    // Cancel rides the connection's progress handler: the tick runs
    // every few thousand virtual-machine ops of the VACUUM, and a
    // false answer interrupts the statement with SQLITE_INTERRUPT.
    // The partial file stays where it is, labeled, for the user to
    // see and remove; the never-delete rule already demands that.
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(tick) = tick {
        let watching = stopped.clone();
        let tick = tick.clone();
        let partial_path = partial.to_path_buf();
        conn.progress_handler(2048, Some(move || {
            if tick(&partial_path) {
                return false;
            }
            watching.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }));
    }
    let outcome = conn.execute("VACUUM INTO ?1", params![partial.to_string_lossy()]);
    if tick.is_some() {
        conn.progress_handler(0, None::<fn() -> bool>);
    }
    if stopped.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(CatalogError::Cancelled(format!(
            "the unfinished copy was left at {} and nothing else changed",
            partial.display()
        )));
    }
    outcome?;
    Ok(())
}

fn vacuum_into_watched(
    conn: &Connection,
    dest: &Path,
    include_thumbnails: bool,
    tick: Option<VacuumTick>,
) -> Result<BackupReport, CatalogError> {
    if std::fs::symlink_metadata(dest).is_ok() {
        return Err(CatalogError::BackupExists(dest.to_string_lossy().to_string()));
    }
    let partial = partial_backup_path(dest);
    if std::fs::symlink_metadata(&partial).is_ok() {
        return Err(CatalogError::BackupExists(partial.to_string_lossy().to_string()));
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(&partial)?;
    // What the source holds before the snapshot; the copy may hold more
    // (a writer that committed in between) but never less.
    let before: (i64, i64) = (
        conn.query_row("SELECT count(*) FROM images", [], |row| row.get(0))?,
        conn.query_row("SELECT count(*) FROM folders", [], |row| row.get(0))?,
    );
    vacuum_statement_watched(conn, &partial, tick.as_ref())?;

    let copy = Connection::open(&partial)?;
    let mut thumbnails_dropped = 0;
    if !include_thumbnails {
        thumbnails_dropped = copy.execute("DELETE FROM thumbnails", [])? as i64;
        copy.execute_batch("VACUUM")?;
    }
    let images: i64 = copy.query_row("SELECT count(*) FROM images", [], |row| row.get(0))?;
    let folders: i64 = copy.query_row("SELECT count(*) FROM folders", [], |row| row.get(0))?;
    drop(copy);
    // The copy is only a backup if it holds what the catalog holds. A
    // snapshot read through a connection that could not see the live
    // journal would be short, and a short backup that wears the name is
    // the failure that costs a catalog (2026-09-19). Another connection
    // may have committed since VACUUM took its snapshot, so the copy may
    // hold more than the source counts now, never less.
    if images < before.0 || folders < before.1 {
        // A writer may also have removed rows in the gap; the count after
        // the snapshot settles it, and only a copy short of both is short.
        let after: (i64, i64) = (
            conn.query_row("SELECT count(*) FROM images", [], |row| row.get(0))?,
            conn.query_row("SELECT count(*) FROM folders", [], |row| row.get(0))?,
        );
        if images < before.0.min(after.0) || folders < before.1.min(after.1) {
            return Err(CatalogError::BackupIncomplete {
                path: partial.to_string_lossy().to_string(),
                images: before.0,
                folders: before.1,
                copy_images: images,
                copy_folders: folders,
            });
        }
    }
    // Complete: it may wear the backup's name now. A watched backup is
    // asked once more first, so a cancel lands before the rename even
    // when the copy itself was too quick to interrupt (or finished
    // while the user was deciding).
    if let Some(tick) = tick.as_ref() {
        if !tick(&partial) {
            return Err(CatalogError::Cancelled(format!(
                "the verified copy was left at {} and never took the backup's name",
                partial.display()
            )));
        }
    }
    std::fs::rename(&partial, dest)?;
    Ok(BackupReport {
        path: dest.to_string_lossy().to_string(),
        bytes: std::fs::metadata(dest)?.len(),
        images,
        folders,
        thumbnails_dropped,
    })
}

impl Catalog {
    /// Opens or creates a catalog, applying any pending schema migrations.
    pub fn open(path: &Path) -> Result<Catalog, CatalogError> {
        let journal_was_present = journal_path(path).is_some_and(|j| std::fs::metadata(j).is_ok_and(|m| m.len() > 0));
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Write-ahead logging, for two reasons. The everyday one: a backup, a
        // served collection and the media server all read the catalog while it
        // is being written, and WAL lets readers and the writer coexist. The one
        // that made it mandatory (2026-09-08): creating a catalog on an exFAT
        // drive failed with "attempt to write a readonly database". macOS mounts
        // exFAT through FSKit now, where a freshly made file's inode changes
        // after its first write; the bundled SQLite's has-the-file-moved check
        // then fires on the SECOND transaction (SQLITE_READONLY_ DBMOVED, 1032).
        // A rollback journal creates and deletes a sibling file per transaction
        // and hits that check every time; WAL passes it once, at the first read,
        // before anything has been written. Reproduced with the crate's own
        // tests run with TMPDIR on such a drive: 19 failures in DELETE mode,
        // none in WAL. The pragma answers with the mode that took; a store that
        // cannot do WAL (some network mounts) keeps its own, which is how it
        // behaved before this line. One caveat WAL brings on that same drive: a
        // SECOND connection to the same file can read a stale snapshot, because
        // the write-ahead index lives in shared memory that FSKit does not keep
        // coherent. The app holds one connection to a live catalog and backs it
        // up through that connection (VACUUM INTO), so it never reads its own
        // catalog through another; a headless serve of a catalog the GUI has
        // open is the one place two connections meet, and it snapshots.
        let mut version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version < 0 {
            return Err(CatalogError::NotACatalog(path.display().to_string()));
        }
        if version > SCHEMA_VERSION {
            return Err(CatalogError::SchemaVersion(version));
        }
        // After the version checks, so a file that is not a catalog is
        // refused in those words rather than by whatever the journal
        // switch says about it.
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        // A journal that was already on disk when this open began was just
        // applied by SQLite. If it belonged to another file (a copy placed over
        // the catalog by hand while the live journal stayed beside it), the
        // result is damage that only shows later as "malformed" mid-session.
        // Checked here, once, in words that say what happened and what to do
        // instead (2026-09-19).
        if journal_was_present {
            let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if check != "ok" {
                return Err(CatalogError::Malformed(path.display().to_string(), check));
            }
        }
        // Remembered for the caller's log: a catalog that silently
        // half-migrates looks exactly like data loss from outside, so
        // the span this open walked is worth a line somewhere visible.
        let migrated = (version < SCHEMA_VERSION).then_some((version, SCHEMA_VERSION));
        while version < SCHEMA_VERSION {
            conn.execute_batch(MIGRATIONS[version as usize])?;
            version += 1;
            conn.pragma_update(None, "user_version", version)?;
        }
        let catalog = Catalog { conn, migrated };
        // Which build last wrote the file, so a future dialog can name
        // it (26.3: the schema-update prompt backs up before migrating,
        // and the copy's value says who wrote the copy's source last).
        catalog.set_meta("written_by", env!("CARGO_PKG_VERSION"))?;
        Ok(catalog)
    }

    /// Whether `path` is the leftover of a create that did not finish: a
    /// SQLite file at schema version 0 that lacks the catalog's tables. A
    /// create that fails midway leaves exactly this (2026-09-08, on an
    /// exFAT drive: one table, version 0, and "is not a Heeler catalog"
    /// ever after), and the caller may set such a file aside and try again.
    /// Anything else answers false: a real catalog, a newer catalog, and a
    /// file that is not SQLite at all, which might be somebody's and is
    /// never touched.
    pub fn is_unfinished(path: &Path) -> bool {
        // The emptiest leftover of all: the zero-byte file create_new
        // makes before SQLite writes a header. Answered from the size,
        // because a read-only SQLite open of an empty file is not
        // reliable on every filesystem (it was not on exFAT).
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() == 0 => return true,
            Ok(meta) if !meta.is_file() => return false,
            Err(_) => return false,
            _ => {}
        }
        let Ok(probe) = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
            return false;
        };
        let Ok(version) = probe.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)) else {
            return false;
        };
        if version != 0 {
            return false;
        }
        let complete = ["images", "folders", "collections"].into_iter().all(|table| {
            probe
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |r| r.get::<_, bool>(0),
                )
                .unwrap_or(false)
        });
        !complete
    }

    /// Existing databases must identify as catalogs before migrations can write.
    pub fn open_existing(path: &Path) -> Result<Catalog, CatalogError> {
        let probe = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| CatalogError::NotACatalog(path.display().to_string()))?;
        let version: i64 = probe.pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| CatalogError::NotACatalog(path.display().to_string()))?;
        if version > SCHEMA_VERSION { return Err(CatalogError::SchemaVersion(version)); }
        if version <= 0 { return Err(CatalogError::NotACatalog(path.display().to_string())); }
        for table in ["images", "folders", "collections"].into_iter().chain((version >= 5).then_some("meta")) {
            let present: bool = probe.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table], |r| r.get(0))?;
            if !present { return Err(CatalogError::NotACatalog(path.display().to_string())); }
        }
        drop(probe);
        Self::open(path)
    }

    /// The (from, to) schema versions open() migrated across, if any.
    pub fn migration_span(&self) -> Option<(i64, i64)> {
        self.migrated
    }

    pub fn open_in_memory() -> Result<Catalog, CatalogError> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // The same list the on-disk path walks, rather than a second copy
        // of it written out by hand. This used to name each migration
        // individually and drifted the moment one was added: every test
        // ran against a schema one version behind the real thing, which
        // is a failure that looks like the new feature being broken.
        for m in MIGRATIONS {
            conn.execute_batch(m)?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        let catalog = Catalog { conn, migrated: None };
        catalog.set_meta("written_by", env!("CARGO_PKG_VERSION"))?;
        Ok(catalog)
    }

    /// The schema version this build migrates to, for the upgrade gate
    /// and its prompts (26.3).
    pub fn current_schema_version() -> i64 {
        SCHEMA_VERSION
    }

    /// Test support, not app code: writes a real catalog stopped at
    /// `version`, so the upgrade gate's tests (in this crate's users)
    /// have a fixture whose schema matches its header.
    #[doc(hidden)]
    pub fn write_catalog_at_version(path: &Path, version: i64) -> Result<(), CatalogError> {
        let conn = Connection::open(path)?;
        for m in &MIGRATIONS[..version as usize] {
            conn.execute_batch(m)?;
        }
        conn.pragma_update(None, "user_version", version)?;
        Ok(())
    }

    /// Runs `f` inside one SQLite transaction. Registering a folder of
    /// images is hundreds of inserts; without this each one pays its own
    /// fsync and a big folder visibly stalls the open.
    pub fn batch<T>(
        &self,
        f: impl FnOnce(&Catalog) -> Result<T, CatalogError>,
    ) -> Result<T, CatalogError> {
        self.conn.execute_batch("BEGIN")?;
        match f(self) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    // Folders ---------------------------------------------------------------

    pub fn add_folder(&self, path: &Path) -> Result<i64, CatalogError> {
        let text = path.to_string_lossy();
        // Browsing to a folder is how a hidden one comes back: adding
        // it again clears the flag rather than doing nothing.
        self.conn.execute(
            "INSERT INTO folders (path) VALUES (?1) ON CONFLICT(path) DO UPDATE SET hidden = 0",
            params![text],
        )?;
        Ok(self
            .conn
            .query_row("SELECT id FROM folders WHERE path = ?1", params![text], |r| {
                r.get(0)
            })?)
    }

    pub fn list_folders(&self) -> Result<Vec<(i64, String)>, CatalogError> {
        let mut stmt = self.conn.prepare("SELECT id, path FROM folders ORDER BY path")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Marks a folder as just-opened, so recents ordering and session
    /// restore know where the user was.
    /// Records that the user deliberately chose this folder, as opposed
    /// to walking into it from the tree. Only these show up in the
    /// library's shortlist.
    pub fn pick_folder(&self, id: i64) -> Result<(), CatalogError> {
        self.conn.execute(
            "UPDATE folders SET picked_at = ?2 WHERE id = ?1",
            params![id, now_unix()],
        )?;
        Ok(())
    }

    pub fn touch_folder(&self, id: i64) -> Result<(), CatalogError> {
        self.conn.execute(
            "UPDATE folders SET last_opened = ?2 WHERE id = ?1",
            params![id, now_unix()],
        )?;
        Ok(())
    }

    /// Folders with image counts, most recently opened first (never-opened
    /// folders trail, ordered by path).
    ///
    /// Trashed photographs are not counted: their files are in `.trash`,
    /// not in the folder, so a count that included them would disagree
    /// with the ribbon the folder opens into (list_images has no flag
    /// that lets a trashed row through). Hidden ones still count: they
    /// are in the folder and one Recover Hidden away from view.
    pub fn folder_summaries(&self) -> Result<Vec<FolderSummary>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.path, f.last_opened, COUNT(i.id)
             FROM folders f LEFT JOIN images i ON i.folder_id = f.id AND i.trashed = 0
             WHERE f.hidden = 0
             GROUP BY f.id
             ORDER BY f.last_opened DESC, f.path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(FolderSummary {
                id: r.get(0)?,
                path: r.get(1)?,
                last_opened: r.get(2)?,
                image_count: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The folder rows at `path` and beneath it: every folder browsed
    /// into is its own row, so a command on a parent must reach them
    /// all. Compared as paths, not as strings, so the separator and a
    /// trailing slash do not matter.
    fn folder_subtree(&self, path: &Path) -> Result<Vec<(i64, String)>, CatalogError> {
        let mut stmt = self.conn.prepare("SELECT id, path FROM folders")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, text) = row?;
            if Path::new(&text).starts_with(path) {
                out.push((id, text));
            }
        }
        Ok(out)
    }

    /// How many folder rows and photographs a folder command at `path`
    /// would reach, subfolders included, so the prompt can say a number.
    pub fn subtree_counts(&self, path: &Path) -> Result<(usize, i64), CatalogError> {
        let folders = self.folder_subtree(path)?;
        let mut images = 0;
        for (id, _) in &folders {
            images += self.conn.query_row(
                "SELECT COUNT(*) FROM images WHERE folder_id = ?1 AND trashed = 0",
                params![id],
                |r| r.get::<_, i64>(0),
            )?;
        }
        Ok((folders.len(), images))
    }

    /// Hides `path` and every folder beneath it from the library. Every
    /// record stays; browsing to the folder again (add_folder) unhides
    /// it. Returns how many folder rows were flagged.
    pub fn hide_folder(&self, path: &Path) -> Result<usize, CatalogError> {
        let folders = self.folder_subtree(path)?;
        for (id, _) in &folders {
            self.conn.execute("UPDATE folders SET hidden = 1 WHERE id = ?1", params![id])?;
        }
        Ok(folders.len())
    }

    /// Forgets `path` and every folder beneath it: the image rows and
    /// everything hanging off them (keywords, EXIF, thumbnails,
    /// collection membership) go, then the folder rows. Nothing on disk
    /// is touched, and the per-image edits are not in this database at
    /// all, so a folder added again gets them back. Returns (folders,
    /// photographs) removed.
    pub fn flush_folder(&self, path: &Path) -> Result<(usize, i64), CatalogError> {
        let folders = self.folder_subtree(path)?;
        self.batch(|c| {
            let mut images = 0;
            for (id, _) in &folders {
                for table in ["keywords", "exif", "thumbnails", "collection_members", "decoded_dims"] {
                    c.conn.execute(
                        &format!("DELETE FROM {table} WHERE image_id IN (SELECT id FROM images WHERE folder_id = ?1)"),
                        params![id],
                    )?;
                }
                images += c.conn.execute("DELETE FROM images WHERE folder_id = ?1", params![id])? as i64;
                c.conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
            }
            Ok((folders.len(), images))
        })
    }

    /// Forgets trashed photographs: the same removal as flush_folder
    /// (the image row and everything hanging off it: keywords, EXIF,
    /// thumbnails, collection membership), for the ids given that are
    /// still trashed, in one transaction. A photograph that is not
    /// trashed (put back meanwhile) is left alone. Nothing on disk is
    /// touched, and the saved edits are not in this database. Returns
    /// how many were forgotten.
    pub fn forget_trashed_images(&self, ids: &[String]) -> Result<usize, CatalogError> {
        use rusqlite::OptionalExtension;
        self.batch(|c| {
            let mut forgotten = 0;
            for id in ids {
                let trashed: Option<i64> = c
                    .conn
                    .query_row("SELECT trashed FROM images WHERE id = ?1", params![id], |r| r.get(0))
                    .optional()?;
                if trashed != Some(1) {
                    continue;
                }
                for table in ["keywords", "exif", "thumbnails", "collection_members", "decoded_dims"] {
                    c.conn.execute(&format!("DELETE FROM {table} WHERE image_id = ?1"), params![id])?;
                }
                forgotten += c.conn.execute("DELETE FROM images WHERE id = ?1 AND trashed = 1", params![id])?;
            }
            Ok(forgotten)
        })
    }

    /// Marks an image as user-edited (drives the thumb badge and the
    /// folder shortlist).
    pub fn set_edited(&self, id: &str) -> Result<(), CatalogError> {
        let n = self
            .conn
            .execute("UPDATE images SET edited = 1 WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    /// Clears the edited mark ("Reset all edits" on a thumbnail).
    pub fn clear_edited(&self, id: &str) -> Result<(), CatalogError> {
        let n = self
            .conn
            .execute("UPDATE images SET edited = 0 WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    /// The library shortlist: folders the user actually chose to open,
    /// most recent first, capped. Walking the tree does not qualify, and
    /// neither does having edits: this answers "where was I working",
    /// the way an editor lists recent projects.
    ///
    /// LEFT JOIN, not JOIN, so a folder the user opened that turned out
    /// to hold no images still lists (with a count of zero) rather than
    /// silently going missing from their own recents. Trashed rows are
    /// left out of the count here for the same reason as in
    /// folder_summaries: their files are not in the folder.
    pub fn recent_picked_folders(&self, limit: usize) -> Result<Vec<FolderSummary>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.path, f.last_opened, COUNT(i.id)
             FROM folders f LEFT JOIN images i ON i.folder_id = f.id AND i.trashed = 0
             WHERE f.picked_at > 0
             GROUP BY f.id
             ORDER BY f.picked_at DESC, f.path
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(FolderSummary {
                id: r.get(0)?,
                path: r.get(1)?,
                last_opened: r.get(2)?,
                image_count: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Session key-value store: tree root, last position, and whatever
    /// other small resume state the app needs.
    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), CatalogError> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, CatalogError> {
        let result = self.conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    /// Paths of every folder containing at least one edited image, for
    /// the library's per-folder edited badges.
    pub fn edited_folder_paths(&self) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT f.path FROM folders f
             JOIN images i ON i.folder_id = f.id
             WHERE i.edited = 1
             ORDER BY f.path",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Overall catalog stats for the library header.
    pub fn counts(&self) -> Result<(i64, i64, i64), CatalogError> {
        let images = self.conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))?;
        let folders = self.conn.query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))?;
        let collections =
            self.conn.query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))?;
        Ok((images, folders, collections))
    }

    // Catalog management ----------------------------------------------------

    /// What a catalog is made of, so the app can tell the user whether a
    /// backup is a nuisance or nothing.
    ///
    /// Measured rather than guessed, because the answer decides the
    /// default: on a real 4,184 image catalog the file is 10.3 MB of
    /// which 8.7 MB is cached thumbnails. The metadata nobody can
    /// regenerate is about 390 bytes an image, so a backup that leaves
    /// the thumbnails behind is roughly a fortieth of the size and loses
    /// nothing that matters.
    pub fn stats(&self) -> Result<CatalogStats, CatalogError> {
        let (images, folders, collections) = self.counts()?;
        let thumbnail_bytes: i64 = self
            .conn
            .query_row("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM thumbnails", [], |r| r.get(0))?;
        let thumbnails: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM thumbnails", [], |r| r.get(0))?;
        let hidden: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM images WHERE hidden = 1", [], |r| r.get(0))?;
        let page_size: i64 = self.conn.pragma_query_value(None, "page_size", |r| r.get(0))?;
        let page_count: i64 = self.conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
        Ok(CatalogStats {
            images,
            folders,
            collections,
            thumbnails,
            hidden,
            thumbnail_bytes,
            total_bytes: page_size * page_count,
        })
    }

    /// Read-only recovery inspection, without migrations, WAL changes or cache writes.
    /// Each row is the id, the path the catalog records and whether the
    /// photograph is trashed. A trashed photograph's row keeps the path it
    /// came from (Put Back renames it home): where its file sits inside
    /// `.trash` is the trash index's to say, so the caller asks it.
    pub fn recovery_inventory(path: &Path) -> Result<(i64, Vec<(String, String, bool)>), CatalogError> {
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > SCHEMA_VERSION { return Err(CatalogError::SchemaVersion(version)); }
        // Older is refused with its own words: "newer than this build"
        // sends the user upgrading when the bundle simply predates them.
        if version < SCHEMA_VERSION { return Err(CatalogError::SchemaTooOld(version)); }
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if check != "ok" { return Err(CatalogError::NotACatalog(check)); }
        let mut stmt = conn.prepare("SELECT id, path, trashed FROM images ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?)))?;
        let mut images = Vec::new();
        for row in rows {
            images.push(row?);
        }
        Ok((version, images))
    }

    /// Writes a compact copy of the catalog to `dest`.
    ///
    /// VACUUM INTO rather than copying the file: it takes a consistent
    /// snapshot of a database that is open and possibly mid-write, which
    /// a file copy does not, and it defragments on the way out. It also
    /// refuses to write over an existing file, which is a property worth
    /// keeping rather than working around: a backup that silently
    /// clobbers last week's backup is not a backup.
    ///
    /// Thumbnails are dropped by default. They are 85% of the bytes and
    /// every one of them can be rebuilt from the RAW it came from.
    pub fn backup_to(
        &self,
        dest: &Path,
        include_thumbnails: bool,
    ) -> Result<BackupReport, CatalogError> {
        self.backup_to_watched(dest, include_thumbnails, None)
    }

    /// backup_to with a progress-and-cancel probe: the tick is called
    /// with the partial file's path as the copy grows and once more
    /// after verification, and a false answer cancels (the partial is
    /// left in place and named in the `Cancelled` error).
    pub fn backup_to_watched(
        &self,
        dest: &Path,
        include_thumbnails: bool,
        tick: Option<VacuumTick>,
    ) -> Result<BackupReport, CatalogError> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        vacuum_into_watched(&self.conn, dest, include_thumbnails, tick)
    }

    /// Writes the same snapshot without creating any parent directories.
    /// Scheduled backups must not recreate a disconnected drive's path locally,
    /// even if the folder disappears after the caller checked it.
    ///
    /// The copy is written under the destination's name plus ".partial"
    /// and renamed into place only once it is complete, so the backup's
    /// name is never worn by a file that is not one: a copy that failed
    /// halfway leaves a clearly labeled leftover, not an empty file that
    /// looks like a backup to the person restoring after a disaster
    /// (2026-09-09). Nothing is deleted here; the leftover stays for the
    /// user to see and remove.
    pub fn backup_to_existing_folder(
        &self,
        dest: &Path,
        include_thumbnails: bool,
    ) -> Result<BackupReport, CatalogError> {
        vacuum_into(&self.conn, dest, include_thumbnails)
    }

    /// Whether opening `path` would migrate it: Some((from, to)) with
    /// this build's schema version as `to`. A read-only probe; the file
    /// is not opened for write and nothing migrates. Newer and foreign
    /// files are refused in the same words open_existing uses.
    pub fn pending_upgrade(path: &Path) -> Result<Option<(i64, i64)>, CatalogError> {
        let probe = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| CatalogError::NotACatalog(path.display().to_string()))?;
        let version: i64 = probe
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| CatalogError::NotACatalog(path.display().to_string()))?;
        if version > SCHEMA_VERSION { return Err(CatalogError::SchemaVersion(version)); }
        if version <= 0 { return Err(CatalogError::NotACatalog(path.display().to_string())); }
        Ok((version < SCHEMA_VERSION).then_some((version, SCHEMA_VERSION)))
    }

    /// A backup of a catalog this build has not opened: the pre-upgrade
    /// copy the schema-update prompt offers. Read-only end to end on the
    /// source (VACUUM INTO reads it, never writes it), so the file keeps
    /// its schema version and an older Heeler can still open it; the
    /// never-overwrite and .partial rules are backup_to's.
    pub fn snapshot_unopened(
        path: &Path,
        dest: &Path,
        include_thumbnails: bool,
    ) -> Result<BackupReport, CatalogError> {
        // Read-write, not read-only: the copy must include every page
        // still sitting in the -wal journal, and a checkpoint folds the
        // journal into the file first, so the copy is whole whatever a
        // second connection can or cannot see of the shared-memory
        // index (the exFAT caveat in `open`). Nothing here migrates:
        // this is a plain SQLite connection, not `Catalog::open`.
        let conn = Connection::open(path)?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        vacuum_into(&conn, dest, include_thumbnails)
    }

    /// Folds the journal into the file and empties it: what a clean exit
    /// does before the connection drops, since a -wal left beside the
    /// file is the trap a hand-made restore falls into (the journal from
    /// the old catalog is applied to the copy placed over it).
    pub fn checkpoint(&self) -> Result<(), CatalogError> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    }

    /// Merges another catalog into this one.
    ///
    /// Existing rows win. Image ids are derived from the file path, so
    /// the same photograph has the same id in every catalog, and a
    /// collision means "this catalog already knows this picture". Keeping
    /// the local row is the only safe direction: importing must never
    /// overwrite the ratings and edits of the catalog being imported
    /// into. Folder ids differ between catalogs, so folders are matched
    /// by path and the ids remapped rather than copied.
    pub fn import_from(&self, other: &Path) -> Result<ImportReport, CatalogError> {
        self.import_from_watched(other, std::sync::Arc::new(|| false), &mut |_, _, _| {})
    }

    /// import_from with a should-stop flag and a progress callback
    /// (rows examined, rows added, rows to examine in total). The flag
    /// is polled between statements and, through the connection's
    /// progress handler, inside them: the images insert is most of a
    /// large merge and a stop must not wait for it. Either way the stop
    /// lands inside the one transaction, so the batch rolls back and
    /// nothing half-lands.
    pub fn import_from_watched(
        &self,
        other: &Path,
        should_stop: StopFlag,
        progress: &mut dyn FnMut(u64, u64, u64),
    ) -> Result<ImportReport, CatalogError> {
        if !other.exists() {
            return Err(CatalogError::NotACatalog(other.to_string_lossy().to_string()));
        }
        let src_version;
        {
            // Refuse a file we cannot read as a catalog of a version we
            // understand, rather than half-importing and leaving the
            // user to work out what landed.
            let probe = Connection::open_with_flags(other, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let version: i64 = probe
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(|_| CatalogError::NotACatalog(other.to_string_lossy().to_string()))?;
            if version <= 0 {
                return Err(CatalogError::NotACatalog(other.to_string_lossy().to_string()));
            }
            if version > SCHEMA_VERSION {
                return Err(CatalogError::SchemaVersion(version));
            }
            src_version = version;
        }
        self.conn
            .execute("ATTACH DATABASE ?1 AS src", params![other.to_string_lossy()])?;
        // One transaction around the whole merge: the five statements
        // below were each atomic on their own, but the sequence was not,
        // and a crash mid-import left a catalog that knew the folders
        // but not the images. Now the import lands whole or not at all.
        //
        // The source is opened read-only for the probe and never
        // migrated, so its schema can be older than this build's: the
        // merge reads the columns its version actually has and defaults
        // the rest (a v12 source has no `trashed` to carry).
        //
        // The row counts ride with the transaction: they are the total
        // the progress row shows, read from the attached source once.
        let count = |table: &str| -> Result<u64, CatalogError> {
            Ok(self.conn.query_row(&format!("SELECT count(*) FROM src.{table}"), [], |r| r.get::<_, i64>(0))? as u64)
        };
        let counted = || -> Result<u64, CatalogError> {
            let mut total = count("folders")? + count("images")? + count("collections")? + count("collection_members")?;
            if src_version >= 11 {
                total += count("keywords")?;
            }
            total += count("thumbnails")?;
            Ok(total)
        };
        // Inside a statement the stop rides the progress handler: a true
        // answer interrupts the statement with SQLITE_INTERRUPT, which
        // rolls the transaction back on its own; the flag below turns
        // that interrupt into the `Cancelled` error the seat expects.
        let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let flag = should_stop.clone();
            let noting = interrupted.clone();
            self.conn.progress_handler(2048, Some(move || {
                if flag() {
                    noting.store(true, std::sync::atomic::Ordering::SeqCst);
                    return true;
                }
                false
            }));
        }
        let stop = || should_stop();
        let result = counted().and_then(|total| {
            let mut examined = 0u64;
            let mut added = 0u64;
            self.batch(|_| {
                self.import_attached(src_version, &stop, &mut |step_examined, step_added| {
                    examined += step_examined;
                    added += step_added;
                    progress(examined, added, total);
                })
            })
        });
        self.conn.progress_handler(0, None::<fn() -> bool>);
        let result = match result {
            Err(CatalogError::Cancelled(words)) => Err(CatalogError::Cancelled(words)),
            Err(_) if interrupted.load(std::sync::atomic::Ordering::SeqCst) => Err(CatalogError::Cancelled(
                "the merge was rolled back, so nothing was added".into(),
            )),
            other => other,
        };
        // Detach whatever happened, or the connection keeps the imported
        // file locked for the rest of the session.
        let _ = self.conn.execute_batch("DETACH DATABASE src");
        result
    }

    fn import_attached(
        &self,
        src_version: i64,
        should_stop: &dyn Fn() -> bool,
        step: &mut dyn FnMut(u64, u64),
    ) -> Result<ImportReport, CatalogError> {
        let stop = || {
            if should_stop() {
                return Err(CatalogError::Cancelled(
                    "the merge was rolled back, so nothing was added".into(),
                ));
            }
            Ok(())
        };
        let examined = |table: &str| -> Result<u64, CatalogError> {
            Ok(self.conn.query_row(&format!("SELECT count(*) FROM src.{table}"), [], |r| r.get::<_, i64>(0))? as u64)
        };

        stop()?;
        let seen = examined("folders")?;
        let folders_added =
            self.conn.execute("INSERT OR IGNORE INTO folders (path) SELECT path FROM src.folders", [])?
                as i64;
        step(seen, folders_added as u64);

        // `trashed` arrived at v13; an older source has no column to
        // read, and its images arrive untrashed. Carrying the mark
        // matters: without it a trashed photograph came in as a live row
        // pointing at a path whose file is sitting in `.trash`: a
        // ribbon entry for a file that is not there, and a "Recover
        // Hidden" style resurrection through the import door.
        let trashed_col = if src_version >= 13 { "si.trashed" } else { "0" };
        stop()?;
        let seen = examined("images")?;
        let images_added = self.conn.execute(
            &format!(
                "INSERT OR IGNORE INTO images
                    (id, path, file_name, extension, folder_id, rating, flag,
                     width, height, added_at, edited, hidden, trashed)
                 SELECT si.id, si.path, si.file_name, si.extension,
                        (SELECT f.id FROM folders f
                           JOIN src.folders sf ON sf.path = f.path
                          WHERE sf.id = si.folder_id),
                        si.rating, si.flag, si.width, si.height, si.added_at,
                        si.edited, si.hidden, {trashed_col}
                   FROM src.images si"
            ),
            [],
        )? as i64;
        step(seen, images_added as u64);

        stop()?;
        let seen = examined("collections")?;
        let collections_added = self.conn.execute(
            "INSERT OR IGNORE INTO collections (name, graph_id)
             SELECT name, graph_id FROM src.collections",
            [],
        )? as i64;
        step(seen, collections_added as u64);

        // Memberships are remapped through both names and ids, and
        // attach to every image this catalog now has, including ones it
        // already knew, so importing a colleague's selects fills in the
        // photographs you share rather than only the ones you lacked.
        // Additive, never overwriting: the local image row itself still
        // wins every column it owns.
        stop()?;
        let seen = examined("collection_members")?;
        let members_added = self.conn.execute(
            "INSERT OR IGNORE INTO collection_members (collection_id, image_id)
             SELECT (SELECT c.id FROM collections c
                       JOIN src.collections sc ON sc.name = c.name
                      WHERE sc.id = scm.collection_id),
                    scm.image_id
               FROM src.collection_members scm
              WHERE scm.image_id IN (SELECT id FROM images)",
            [],
        )?;
        step(seen, members_added as u64);

        // Link groups came at v16: user work, carried onto the rows this
        // catalog now holds and did not already link.
        if src_version >= 16 {
            stop()?;
            self.conn.execute(
                "UPDATE images SET link_group = (SELECT si.link_group FROM src.images si WHERE si.id = images.id)
                  WHERE link_group IS NULL AND id IN (SELECT id FROM src.images WHERE link_group IS NOT NULL)",
                [],
            )?;
        }

        // Keywords came at v11. They are user work, not a cache, so they
        // make the trip with the same rule as memberships: an image this
        // catalog already knew keeps its own row, but the imported
        // catalog's tags still attach to it.
        if src_version >= 11 {
            stop()?;
            let seen = examined("keywords")?;
            let keywords_added = self.conn.execute(
                "INSERT OR IGNORE INTO keywords (image_id, keyword)
                 SELECT image_id, keyword FROM src.keywords
                  WHERE image_id IN (SELECT id FROM images)",
                [],
            )?;
            step(seen, keywords_added as u64);
        }

        // Thumbnails last, and only for images this catalog now has. They
        // are a cache: if any of this is wrong they rebuild.
        stop()?;
        let seen = examined("thumbnails")?;
        let thumbs_added = self.conn.execute(
            "INSERT OR IGNORE INTO thumbnails (image_id, kind, data, updated_at)
             SELECT image_id, kind, data, updated_at FROM src.thumbnails
              WHERE image_id IN (SELECT id FROM images)",
            [],
        )?;
        step(seen, thumbs_added as u64);

        let total_incoming: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM src.images", [], |r| r.get(0))?;
        Ok(ImportReport {
            folders_added,
            images_added,
            collections_added,
            images_skipped: total_incoming - images_added,
        })
    }

    // Images ----------------------------------------------------------------

    pub fn add_image(
        &self,
        id: &str,
        path: &Path,
        folder_id: Option<i64>,
    ) -> Result<(), CatalogError> {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        self.conn.execute(
            "INSERT INTO images (id, path, file_name, extension, folder_id, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, path.to_string_lossy(), file_name, extension, folder_id, now_unix()],
        )?;
        Ok(())
    }

    /// Points an image at the folder it actually lives in. Rescans call
    /// this because the pre-lazy-scan era registered whole trees under
    /// the root folder, leaving folder_id wrong for anything deeper.
    pub fn assign_folder(&self, id: &str, folder_id: i64) -> Result<(), CatalogError> {
        let n = self.conn.execute(
            "UPDATE images SET folder_id = ?2 WHERE id = ?1",
            params![id, folder_id],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    /// Records the size a full decode of `id` under `source_key` found
    /// (v18). The header's width and height are left as they are.
    pub fn set_decoded_dimensions(&self, id: &str, source_key: &str, width: u32, height: u32) -> Result<(), CatalogError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO decoded_dims (image_id, source_key, width, height) VALUES (?1, ?2, ?3, ?4)",
            params![id, source_key, width, height],
        )?;
        Ok(())
    }

    /// The size a full decode of `id` under `source_key` found, if one
    /// has happened since the file last changed.
    pub fn decoded_dimensions(&self, id: &str, source_key: &str) -> Result<Option<(u32, u32)>, CatalogError> {
        match self.conn.query_row(
            "SELECT width, height FROM decoded_dims WHERE image_id = ?1 AND source_key = ?2",
            params![id, source_key],
            |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?)),
        ) {
            Ok(dims) => Ok(Some(dims)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    pub fn set_dimensions(&self, id: &str, width: u32, height: u32) -> Result<(), CatalogError> {
        let n = self.conn.execute(
            "UPDATE images SET width = ?2, height = ?3 WHERE id = ?1",
            params![id, width, height],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn set_rating(&self, id: &str, rating: u8) -> Result<(), CatalogError> {
        if rating > 5 {
            return Err(CatalogError::InvalidRating(rating as i64));
        }
        let n = self.conn.execute(
            "UPDATE images SET rating = ?2 WHERE id = ?1",
            params![id, rating],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn set_flag(&self, id: &str, flag: Flag) -> Result<(), CatalogError> {
        let n = self.conn.execute(
            "UPDATE images SET flag = ?2 WHERE id = ?1",
            params![id, flag.as_str()],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn image(&self, id: &str) -> Result<ImageRecord, CatalogError> {
        self.conn
            .query_row(
                "SELECT id, path, file_name, extension, folder_id, rating, flag, width, height, added_at, edited, link_group
                 FROM images WHERE id = ?1",
                params![id],
                row_to_image,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => CatalogError::ImageNotFound(id.to_string()),
                other => CatalogError::Sql(other),
            })
    }

    /// Looks an image up by its source path, for idempotent folder rescans.
    /// Points an existing image at a file that has moved.
    ///
    /// The id does not change, which is the whole point: it keys the
    /// saved graph, the thumbnail cache, the keywords and every
    /// collection this photograph belongs to. A moved file that came
    /// back as a new row would be a stranger with the same picture on
    /// it, and the edits would be sitting on an id nothing points at.
    ///
    /// So relinking is an UPDATE, deliberately, even though ids are
    /// derived from paths everywhere else. The derivation makes a new
    /// id; it does not own an old one.
    pub fn set_image_path(
        &self,
        id: &str,
        path: &Path,
        folder_id: Option<i64>,
    ) -> Result<(), CatalogError> {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let n = self.conn.execute(
            "UPDATE images SET path = ?2, file_name = ?3, extension = ?4,
                    folder_id = COALESCE(?5, folder_id)
             WHERE id = ?1",
            params![id, path.to_string_lossy(), file_name, extension, folder_id],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn image_id_by_path(&self, path: &Path) -> Result<Option<String>, CatalogError> {
        let result = self.conn.query_row(
            "SELECT id FROM images WHERE path = ?1",
            params![path.to_string_lossy()],
            |r| r.get::<_, String>(0),
        );
        match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    /// Removes an image and everything hanging off it (memberships,
    /// thumbnail, cached camera data). Graph files are the project
    /// layer's responsibility.
    pub fn remove_image(&self, id: &str) -> Result<(), CatalogError> {
        // One transaction, and the exif row is not optional: the v8
        // camera cache references the image with foreign keys enforced,
        // so removing an image whose EXIF had been cached failed the
        // whole delete on the constraint. A crash between the deletes
        // leaves orphans no query would ever find, so they commit or
        // they do not happen.
        self.batch(|c| {
            c.conn
                .execute("DELETE FROM collection_members WHERE image_id = ?1", params![id])?;
            c.conn
                .execute("DELETE FROM thumbnails WHERE image_id = ?1", params![id])?;
            c.conn.execute("DELETE FROM exif WHERE image_id = ?1", params![id])?;
            c.conn.execute("DELETE FROM keywords WHERE image_id = ?1", params![id])?;
            c.conn.execute("DELETE FROM decoded_dims WHERE image_id = ?1", params![id])?;
            let n = c
                .conn
                .execute("DELETE FROM images WHERE id = ?1", params![id])?;
            if n == 0 {
                return Err(CatalogError::ImageNotFound(id.to_string()));
            }
            Ok(())
        })
    }

    // Hiding ----------------------------------------------------------------

    /// Hides an image from the catalog, or brings it back.
    ///
    /// Nothing else is touched. The rating, the flag, the edited mark,
    /// the collection memberships and the saved graph all survive, which
    /// is the whole difference between this and `remove_image`: unhiding
    /// has to give back the photograph the user had, not a stranger with
    /// the same filename.
    /// Puts every id into one link group, or takes them out of theirs
    /// (`None`). Unknown ids are skipped rather than failing the batch:
    /// a stale selection should not stop the rest from linking.
    pub fn set_link_group(&self, ids: &[String], group: Option<&str>) -> Result<(), CatalogError> {
        self.batch(|c| {
            for id in ids {
                c.conn.execute("UPDATE images SET link_group = ?2 WHERE id = ?1", params![id, group])?;
            }
            Ok(())
        })
    }

    pub fn set_hidden(&self, id: &str, hidden: bool) -> Result<(), CatalogError> {
        let n = self.conn.execute(
            "UPDATE images SET hidden = ?2 WHERE id = ?1",
            params![id, i64::from(hidden)],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    /// Marks an image as living in the `.trash` folder beside it, or
    /// as being back where it belongs.
    ///
    /// Deliberately separate from `set_hidden`. Hiding is about the
    /// library; this is about where the file is. An image can be neither,
    /// and the two recoveries must not reach each other's rows.
    pub fn set_trashed(&self, id: &str, trashed: bool) -> Result<(), CatalogError> {
        let n = self.conn.execute(
            "UPDATE images SET trashed = ?2 WHERE id = ?1",
            params![id, i64::from(trashed)],
        )?;
        if n == 0 {
            return Err(CatalogError::ImageNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn is_trashed(&self, id: &str) -> Result<bool, CatalogError> {
        let trashed: i64 = self
            .conn
            .query_row("SELECT trashed FROM images WHERE id = ?1", params![id], |r| r.get(0))
            .map_err(|_| CatalogError::ImageNotFound(id.to_string()))?;
        Ok(trashed != 0)
    }

    /// Everything currently in the trash, ordered by folder then file
    /// name: the order a Put-Back sweep walks, not a recency list.
    /// (`trashed_at` lives in the `.trash` manifest, not in this row, so
    /// the catalog could not order by it even if asked.)
    ///
    /// `path` on these records is where the photograph came FROM and
    /// where Put Back will return it, not where the file is sitting now.
    /// The file is under `.trash` beside that path; the manifest there
    /// holds the mapping, and this is the catalog's half of the same
    /// story.
    pub fn list_trashed(&self, folder_id: Option<i64>) -> Result<Vec<ImageRecord>, CatalogError> {
        let mut sql = String::from(
            "SELECT i.id, i.path, i.file_name, i.extension, i.folder_id, i.rating, i.flag,
                    i.width, i.height, i.added_at, i.edited, i.link_group
             FROM images i WHERE i.trashed = 1",
        );
        let mut binds: Vec<SqlValue> = Vec::new();
        if let Some(fid) = folder_id {
            sql.push_str(" AND i.folder_id = ?");
            binds.push(SqlValue::Integer(fid));
        }
        sql.push_str(" ORDER BY i.folder_id, i.file_name, i.id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), row_to_image)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// How many photographs sit in the trash beside a folder. The number
    /// behind the folder tree's badge: the only way somebody learns
    /// about a `.trash` without going looking for one.
    pub fn trashed_count(&self, folder_path: &Path) -> Result<i64, CatalogError> {
        let path = folder_path.to_string_lossy().to_string();
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM images i
             JOIN folders f ON f.id = i.folder_id
             WHERE f.path = ?1 AND i.trashed = 1",
            params![path],
            |r| r.get(0),
        )?)
    }

    pub fn is_hidden(&self, id: &str) -> Result<bool, CatalogError> {
        let hidden: i64 = self
            .conn
            .query_row("SELECT hidden FROM images WHERE id = ?1", params![id], |r| r.get(0))
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CatalogError::ImageNotFound(id.to_string())
                }
                other => CatalogError::from(other),
            })?;
        Ok(hidden != 0)
    }

    /// How many images are hidden in a folder.
    ///
    /// This is what the Recover Hidden dialog counts before it asks, so
    /// the user is told a number rather than agreeing to an unknown.
    pub fn hidden_count(&self, folder_path: &Path) -> Result<i64, CatalogError> {
        let path = folder_path.to_string_lossy().to_string();
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM images i
             JOIN folders f ON f.id = i.folder_id
             WHERE f.path = ?1 AND i.hidden = 1",
            params![path],
            |r| r.get(0),
        )?)
    }

    /// Unhides every hidden image in a folder, returning how many came
    /// back. Zero is not an error: a folder with nothing hidden is the
    /// ordinary case and the caller decides whether to mention it.
    pub fn recover_hidden(&self, folder_path: &Path) -> Result<i64, CatalogError> {
        let path = folder_path.to_string_lossy().to_string();
        let n = self.conn.execute(
            "UPDATE images SET hidden = 0
             WHERE hidden = 1
               AND folder_id IN (SELECT id FROM folders WHERE path = ?1)",
            params![path],
        )?;
        Ok(n as i64)
    }

    /// Folders that have anything hidden in them, so the tree can offer
    /// Recover Hidden only where it would do something.
    pub fn folders_with_hidden(&self) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT f.path FROM folders f
             JOIN images i ON i.folder_id = f.id
             WHERE i.hidden = 1
             ORDER BY f.path",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Ids of a folder's hidden images, as one set for the folder scan.
    ///
    /// The scan registers and heals every file it finds on disk, but a
    /// hidden photograph must not come back into the listing just
    /// because its folder was reopened; hiding that lasts only until
    /// the next open is not hiding. Read once per folder rather than
    /// asked per file, the same bargain the trashed set makes: a scan
    /// of four thousand photographs should not be four thousand queries.
    pub fn hidden_ids_in_folder(&self, folder_id: i64) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM images WHERE folder_id = ?1 AND hidden = 1")?;
        let rows = stmt.query_map(params![folder_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Folders holding trashed photographs, so the tree can say which
    /// ones have a `.trash` beside them without statting the disk.
    ///
    /// The count behind the badge and the gate on the folder menu's
    /// "Show Trash". Both read this rather than the disk so they agree
    /// with each other and with the library.
    pub fn folders_with_trash(&self) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT f.path FROM folders f
             JOIN images i ON i.folder_id = f.id
             WHERE i.trashed = 1
             ORDER BY f.path",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Lists images matching the filter, ordered by file name then id for
    /// stable filmstrip ordering.
    pub fn list_images(&self, filter: &Filter) -> Result<Vec<ImageRecord>, CatalogError> {
        let mut sql = String::from(
            "SELECT i.id, i.path, i.file_name, i.extension, i.folder_id, i.rating, i.flag,
                    i.width, i.height, i.added_at, i.edited, i.link_group
             FROM images i",
        );
        let mut binds: Vec<SqlValue> = Vec::new();
        if let Some(cid) = filter.collection_id {
            sql.push_str(" JOIN collection_members cm ON cm.image_id = i.id AND cm.collection_id = ?");
            binds.push(SqlValue::Integer(cid));
        }
        if let Some(kw) = &filter.keyword {
            sql.push_str(" JOIN keywords k ON k.image_id = i.id AND k.keyword = ?");
            binds.push(SqlValue::Text(kw.trim().to_string()));
        }
        sql.push_str(" WHERE 1 = 1");
        // Unconditional, unlike hidden. There is no filter flag that
        // lets a trashed photograph into an ordinary listing, because
        // its file is not where this row says it is: the only honest
        // reader of a trashed row is `list_trashed`, which knows to look
        // in `.trash` instead.
        sql.push_str(" AND i.trashed = 0");
        if !filter.include_hidden {
            sql.push_str(" AND i.hidden = 0");
        }
        if let Some(r) = filter.min_rating {
            sql.push_str(" AND i.rating >= ?");
            binds.push(SqlValue::Integer(r as i64));
        }
        if let Some(f) = filter.flag {
            sql.push_str(" AND i.flag = ?");
            binds.push(SqlValue::Text(f.as_str().to_string()));
        }
        if let Some(ext) = &filter.extension {
            sql.push_str(" AND i.extension = ?");
            binds.push(SqlValue::Text(ext.to_ascii_lowercase()));
        }
        if let Some(fid) = filter.folder_id {
            sql.push_str(" AND i.folder_id = ?");
            binds.push(SqlValue::Integer(fid));
        } else {
            // A hidden folder's photographs stay out of every listing
            // that is not the folder itself: the catalog-wide filters,
            // search, the expanded table, a collection's members. Asking
            // for the folder by id is browsing to it, which unhides it.
            sql.push_str(" AND (i.folder_id IS NULL OR i.folder_id NOT IN (SELECT id FROM folders WHERE hidden = 1))");
        }
        sql.push_str(" ORDER BY i.file_name, i.id");

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), row_to_image)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // Collections -----------------------------------------------------------

    pub fn create_collection(&self, name: &str) -> Result<i64, CatalogError> {
        // A taken name gets words, not SQLite's error code: the library
        // panel's new-collection field surfaces this string as-is, and
        // "UNIQUE constraint failed: collections.name" says nothing about
        // what the user did.
        match self
            .conn
            .execute("INSERT INTO collections (name) VALUES (?1)", params![name])
        {
            Ok(_) => Ok(self.conn.last_insert_rowid()),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Err(CatalogError::CollectionExists(name.to_string()))
            }
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionRecord>, CatalogError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, graph_id FROM collections ORDER BY name")?;
        let rows = stmt.query_map([], |r| {
            Ok(CollectionRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                graph_id: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn rename_collection(&self, id: i64, name: &str) -> Result<(), CatalogError> {
        // Renaming onto a taken name trips the same UNIQUE constraint
        // create does; give it the same words.
        match self.conn.execute(
            "UPDATE collections SET name = ?2 WHERE id = ?1",
            params![id, name],
        ) {
            Ok(0) => Err(CatalogError::CollectionNotFound(id.to_string())),
            Ok(_) => Ok(()),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Err(CatalogError::CollectionExists(name.to_string()))
            }
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    /// Deletes a collection and its memberships. Images stay in the catalog.
    pub fn delete_collection(&self, id: i64) -> Result<(), CatalogError> {
        // Two deletes, one transaction: a crash between them would leave
        // memberships pointing at a collection that no longer exists.
        self.batch(|c| {
            c.conn.execute(
                "DELETE FROM collection_members WHERE collection_id = ?1",
                params![id],
            )?;
            let n = c
                .conn
                .execute("DELETE FROM collections WHERE id = ?1", params![id])?;
            if n == 0 {
                return Err(CatalogError::CollectionNotFound(id.to_string()));
            }
            Ok(())
        })
    }

    // Keywords --------------------------------------------------------------

    /// Replaces an image's keywords wholesale. Set semantics rather than
    /// add/remove pairs: the tag field edits the whole list at once, and
    /// replace-all cannot drift from what the field shows. Terms are
    /// trimmed; empties dropped; case folds in the table's collation.
    pub fn set_keywords(&self, id: &str, keywords: &[String]) -> Result<(), CatalogError> {
        self.batch(|c| {
            c.conn.execute("DELETE FROM keywords WHERE image_id = ?1", params![id])?;
            for kw in keywords {
                let kw = kw.trim();
                if kw.is_empty() {
                    continue;
                }
                c.conn.execute(
                    "INSERT OR IGNORE INTO keywords (image_id, keyword) VALUES (?1, ?2)",
                    params![id, kw],
                )?;
            }
            Ok(())
        })
    }

    pub fn keywords_of(&self, id: &str) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self
            .conn
            .prepare("SELECT keyword FROM keywords WHERE image_id = ?1 ORDER BY keyword")?;
        let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every keyword in the catalog, for the tag field's autocomplete.
    pub fn all_keywords(&self) -> Result<Vec<String>, CatalogError> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT keyword FROM keywords ORDER BY keyword")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Collections with member counts, for the library panel.
    ///
    /// A trashed member is not counted: its file is in `.trash` beside
    /// its folder, so opening the collection cannot show it, and the
    /// badge must agree with what opening shows. Put Back restores both
    /// the file and the count, since the membership was never touched.
    pub fn collection_summaries(&self) -> Result<Vec<CollectionSummary>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.name, c.graph_id, COUNT(i.id)
             FROM collections c
             LEFT JOIN collection_members m ON m.collection_id = c.id
             LEFT JOIN images i ON i.id = m.image_id AND i.trashed = 0
             GROUP BY c.id
             ORDER BY c.name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CollectionSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                graph_id: r.get(2)?,
                image_count: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Attaches or clears the collection-level graph (the "look" badge in
    /// the library panel reads this).
    pub fn set_collection_graph(&self, id: i64, graph_id: Option<&str>) -> Result<(), CatalogError> {
        let n = self.conn.execute(
            "UPDATE collections SET graph_id = ?2 WHERE id = ?1",
            params![id, graph_id],
        )?;
        if n == 0 {
            return Err(CatalogError::CollectionNotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn add_to_collection(&self, collection_id: i64, image_id: &str) -> Result<(), CatalogError> {
        self.conn.execute(
            "INSERT INTO collection_members (collection_id, image_id) VALUES (?1, ?2)
             ON CONFLICT DO NOTHING",
            params![collection_id, image_id],
        )?;
        Ok(())
    }

    pub fn remove_from_collection(
        &self,
        collection_id: i64,
        image_id: &str,
    ) -> Result<(), CatalogError> {
        self.conn.execute(
            "DELETE FROM collection_members WHERE collection_id = ?1 AND image_id = ?2",
            params![collection_id, image_id],
        )?;
        Ok(())
    }

    // Thumbnails ------------------------------------------------------------

    /// Upserts the thumbnail. A rendered thumb replaces an embedded one; the
    /// app layer re-stores after edits to keep filmstrip thumbs accurate.
    pub fn store_thumbnail(
        &self,
        image_id: &str,
        kind: ThumbKind,
        data: &[u8],
    ) -> Result<(), CatalogError> {
        self.conn.execute(
            "INSERT INTO thumbnails (image_id, kind, data, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(image_id) DO UPDATE SET kind = ?2, data = ?3, updated_at = ?4",
            params![image_id, kind.as_str(), data, now_unix()],
        )?;
        Ok(())
    }

    pub fn thumbnail(&self, image_id: &str) -> Result<Option<(ThumbKind, Vec<u8>)>, CatalogError> {
        let result = self.conn.query_row(
            "SELECT kind, data FROM thumbnails WHERE image_id = ?1",
            params![image_id],
            |r| {
                let kind: String = r.get(0)?;
                Ok((ThumbKind::parse(&kind), r.get::<_, Vec<u8>>(1)?))
            },
        );
        match result {
            Ok(t) => Ok(Some(t)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    pub fn clear_thumbnail(&self, image_id: &str) -> Result<(), CatalogError> {
        self.conn
            .execute("DELETE FROM thumbnails WHERE image_id = ?1", params![image_id])?;
        Ok(())
    }

    /// Drops every thumbnail and gives the space back: a cache the user
    /// may clear from Preferences to manage their disk. Thumbnails
    /// rebuild as photographs are viewed. VACUUM follows the delete
    /// because SQLite keeps freed pages inside the file otherwise, and
    /// a clear that leaves the file the same size is not a clear.
    /// Returns how many were dropped.
    pub fn clear_thumbnails(&self) -> Result<i64, CatalogError> {
        let dropped = self.conn.execute("DELETE FROM thumbnails", [])? as i64;
        self.conn.execute_batch("VACUUM")?;
        Ok(dropped)
    }

    /// Stores what was read out of a photograph's headers, stamped with
    /// the reader version that produced it: a reading is a function of
    /// the file AND the reader, and the stamp is what lets a smarter
    /// reader see through records its predecessors wrote.
    pub fn put_exif(&self, image_id: &str, e: &ExifRecord, reader: i64) -> Result<(), CatalogError> {
        self.conn.execute(
            "INSERT INTO exif
               (image_id, camera, lens, shot_at, iso, aperture, shutter, focal,
                exposure_bias, artist, copyright, read_at, reader)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(image_id) DO UPDATE SET
               camera=excluded.camera, lens=excluded.lens, shot_at=excluded.shot_at,
               iso=excluded.iso, aperture=excluded.aperture, shutter=excluded.shutter,
               focal=excluded.focal, exposure_bias=excluded.exposure_bias,
               artist=excluded.artist, copyright=excluded.copyright,
               read_at=excluded.read_at, reader=excluded.reader",
            params![
                image_id,
                e.camera,
                e.lens,
                e.shot_at,
                e.iso,
                e.aperture,
                e.shutter,
                e.focal,
                e.exposure_bias,
                e.artist,
                e.copyright,
                now_unix(),
                reader,
            ],
        )?;
        Ok(())
    }

    /// The cached reading and the reader version that wrote it. The
    /// version travels with the record so the caller can decide whether
    /// the record is still an answer or a blind spot to read past.
    pub fn exif(&self, image_id: &str) -> Result<Option<(ExifRecord, i64)>, CatalogError> {
        let result = self.conn.query_row(
            "SELECT camera, lens, shot_at, iso, aperture, shutter, focal, exposure_bias,
                    artist, copyright, reader
             FROM exif WHERE image_id = ?1",
            params![image_id],
            |row| Ok((row_to_exif(row)?, row.get::<_, i64>(10)?)),
        );
        match result {
            Ok(e) => Ok(Some(e)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CatalogError::Sql(e)),
        }
    }

    /// Every cached reading in a folder, keyed by image id.
    ///
    /// One query rather than one per photograph: the column view asks for
    /// a whole folder at once, and four thousand round trips through
    /// SQLite is the difference between instant and not.
    pub fn exif_for_folder(
        &self,
        folder_id: i64,
    ) -> Result<Vec<(String, ExifRecord)>, CatalogError> {
        let mut stmt = self.conn.prepare(
            "SELECT e.image_id, e.camera, e.lens, e.shot_at, e.iso, e.aperture, e.shutter,
                    e.focal, e.exposure_bias, e.artist, e.copyright
             FROM exif e JOIN images i ON i.id = e.image_id
             WHERE i.folder_id = ?1",
        )?;
        let rows = stmt.query_map(params![folder_id], |r| {
            Ok((r.get::<_, String>(0)?, row_to_exif_from(r, 1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(CatalogError::Sql)
    }
}

/// The camera data as the catalog holds it: already formatted for
/// display, because the panel shows "1/250" rather than a rational and
/// nothing else ever needs the pieces.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExifRecord {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub shot_at: Option<String>,
    pub iso: Option<u32>,
    pub aperture: Option<f64>,
    pub shutter: Option<String>,
    pub focal: Option<f64>,
    pub exposure_bias: Option<f64>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
}

fn row_to_exif(row: &rusqlite::Row) -> rusqlite::Result<ExifRecord> {
    row_to_exif_from(row, 0)
}

fn row_to_exif_from(row: &rusqlite::Row, at: usize) -> rusqlite::Result<ExifRecord> {
    Ok(ExifRecord {
        camera: row.get(at)?,
        lens: row.get(at + 1)?,
        shot_at: row.get(at + 2)?,
        iso: row.get(at + 3)?,
        aperture: row.get(at + 4)?,
        shutter: row.get(at + 5)?,
        focal: row.get(at + 6)?,
        exposure_bias: row.get(at + 7)?,
        artist: row.get(at + 8)?,
        copyright: row.get(at + 9)?,
    })
}

fn row_to_image(r: &rusqlite::Row<'_>) -> rusqlite::Result<ImageRecord> {
    let flag: String = r.get(6)?;
    Ok(ImageRecord {
        id: r.get(0)?,
        path: r.get(1)?,
        file_name: r.get(2)?,
        extension: r.get(3)?,
        folder_id: r.get(4)?,
        rating: r.get::<_, i64>(5)? as u8,
        flag: Flag::parse(&flag),
        width: r.get(7)?,
        height: r.get(8)?,
        added_at: r.get(9)?,
        edited: r.get::<_, i64>(10)? != 0,
        link_group: r.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare connection for hand-building legacy or foreign files, in
    /// the journal mode the product uses. Without WAL these fixtures
    /// trip the same moved-file check on exFAT that Catalog::open used
    /// to (2026-09-08), and the exFAT run of this suite (TMPDIR on the
    /// drive) would fail on the fixtures rather than on the product.
    fn raw_open(path: impl AsRef<Path>) -> rusqlite::Result<Connection> {
        let conn = Connection::open(path)?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        Ok(conn)
    }

    fn catalog_with_images() -> Catalog {
        let c = Catalog::open_in_memory().unwrap();
        c.add_image("img_1", Path::new("D:/photos/aaa.dng"), None).unwrap();
        c.add_image("img_2", Path::new("D:/photos/bbb.jpg"), None).unwrap();
        c.add_image("img_3", Path::new("D:/photos/ccc.dng"), None).unwrap();
        c
    }

    #[test]
    fn camera_data_is_cached_and_read_back_whole() {
        // The owner wants a column view over a folder. Reading EXIF out of four
        // thousand RAWs every time the panel opens is four thousand file opens
        // for data that has not changed since the shutter fired.
        let c = catalog_with_images();
        let shot = ExifRecord {
            camera: Some("NIKON Z 7".into()),
            lens: Some("NIKKOR Z 85mm f/1.8 S".into()),
            shot_at: Some("2024:03:11 17:42:08".into()),
            iso: Some(400),
            aperture: Some(2.8),
            shutter: Some("1/250".into()),
            focal: Some(85.0),
            exposure_bias: Some(-0.33),
            artist: None,
            copyright: None,
        };
        c.put_exif("img_1", &shot, 3).unwrap();
        assert_eq!(c.exif("img_1").unwrap(), Some((shot.clone(), 3)));
        // Nothing cached is None, not an empty record: the difference
        // between "no camera data" and "not looked yet" is what decides
        // whether the reader runs.
        assert_eq!(c.exif("img_2").unwrap(), None);

        // Re-reading a file replaces its row rather than failing on the
        // primary key, since a rescan is a normal thing to do.
        let mut again = shot.clone();
        again.iso = Some(1600);
        c.put_exif("img_1", &again, 4).unwrap();
        let (row, reader) = c.exif("img_1").unwrap().unwrap();
        assert_eq!(row.iso, Some(1600));
        // The stamp follows the rewrite: the row now answers for the
        // reader that produced it, not the one before.
        assert_eq!(reader, 4);
    }

    #[test]
    fn a_whole_folder_of_readings_comes_back_in_one_query() {
        let c = Catalog::open_in_memory().unwrap();
        let folder = c.add_folder(Path::new("D:/shoot")).unwrap();
        for id in ["img_1", "img_2", "img_3"] {
            c.add_image(id, Path::new(&format!("D:/shoot/{id}.dng")), Some(folder)).unwrap();
        }
        c.put_exif("img_1", &ExifRecord { iso: Some(100), ..ExifRecord::default() }, 1).unwrap();
        c.put_exif("img_3", &ExifRecord { iso: Some(800), ..ExifRecord::default() }, 1).unwrap();

        let mut rows = c.exif_for_folder(folder).unwrap();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        // Only what has actually been read: the column view fills in as
        // the reader works through the folder rather than blocking on it.
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "img_1");
        assert_eq!(rows[1].1.iso, Some(800));
        // A folder nobody has read yet is empty, not an error.
        let other = c.add_folder(Path::new("D:/other")).unwrap();
        assert!(c.exif_for_folder(other).unwrap().is_empty());
    }

    /// The extension got shorter. Stacks made under the old name are
    /// still on disk, and dropping them out of the library would look
    /// exactly like losing the user's work.
    #[test]
    fn stacks_made_before_the_rename_still_index() {
        assert!(is_stack("stack"));
        assert!(is_stack("heelerstack"));
        assert!(is_stack("STACK"));
        assert!(!is_stack("stacked"));
        assert!(is_supported_extension("stack"));
        assert!(is_supported_extension("heelerstack"));
    }

    /// A panorama is indexed like any other image, which is what makes
    /// ratings, flags, filters and session restore work on it without a
    /// line of special-casing.
    #[test]
    fn panoramas_index_like_photographs() {
        assert!(is_pano("pano"));
        assert!(is_pano("PANO"));
        assert!(!is_pano("panorama"));
        assert!(!is_stack("pano"), "a panorama is not a stack");
        assert!(is_supported_extension("pano"));
    }

    #[test]
    fn open_creates_schema_and_reopen_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        {
            let c = Catalog::open(&path).unwrap();
            c.add_image("img_1", Path::new("D:/p/a.dng"), None).unwrap();
        }
        let c = Catalog::open(&path).unwrap();
        assert_eq!(c.image("img_1").unwrap().file_name, "a.dng");
    }

    #[test]
    fn open_uses_write_ahead_logging_and_reopens_read_only_after_a_clean_close() {
        // The exFAT case (2026-09-08): a rollback journal trips the bundled
        // SQLite's moved-file check on some external drives; WAL does not.
        // Pinned here by the mode, and on such a drive by running this crate's
        // tests with TMPDIR pointing at it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        {
            let c = Catalog::open(&path).unwrap();
            let mode: String = c.conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
            assert_eq!(mode, "wal");
            c.add_image("img_1", Path::new("D:/p/a.dng"), None).unwrap();
        }
        // A clean close folds the log back in; the read-only probe that
        // open_existing starts with must still see a catalog.
        let c = Catalog::open_existing(&path).unwrap();
        assert_eq!(c.image("img_1").unwrap().file_name, "a.dng");
    }

    #[test]
    fn is_unfinished_tells_a_half_made_file_from_a_catalog_and_from_a_stranger() {
        let dir = tempfile::tempdir().unwrap();
        // A create that died after its first table: version 0, one table.
        let half = dir.path().join("half.sqlite");
        {
            let conn = raw_open(&half).unwrap();
            conn.execute_batch("CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);").unwrap();
        }
        assert!(Catalog::is_unfinished(&half));
        // An empty file, which is what create_new leaves before SQLite
        // writes a byte.
        let empty = dir.path().join("empty.sqlite");
        std::fs::write(&empty, b"").unwrap();
        assert!(Catalog::is_unfinished(&empty));
        // A finished catalog is not.
        let whole = dir.path().join("whole.sqlite");
        drop(Catalog::open(&whole).unwrap());
        assert!(!Catalog::is_unfinished(&whole));
        // Somebody's file that merely wears the name is not either, and
        // is never touched.
        let stranger = dir.path().join("stranger.sqlite");
        std::fs::write(&stranger, b"precious bytes").unwrap();
        assert!(!Catalog::is_unfinished(&stranger));
        assert_eq!(std::fs::read(&stranger).unwrap(), b"precious bytes");
        // Nothing at all is not unfinished, it is absent.
        assert!(!Catalog::is_unfinished(&dir.path().join("absent.sqlite")));
    }

    #[test]
    fn hiding_a_folder_keeps_every_record_and_browsing_back_unhides_it() {
        let c = Catalog::open_in_memory().unwrap();
        let top = c.add_folder(Path::new("/shoot")).unwrap();
        let sub = c.add_folder(Path::new("/shoot/day2")).unwrap();
        let other = c.add_folder(Path::new("/shootout")).unwrap();
        c.add_image("a", Path::new("/shoot/a.dng"), Some(top)).unwrap();
        c.add_image("b", Path::new("/shoot/day2/b.dng"), Some(sub)).unwrap();
        c.add_image("z", Path::new("/shootout/z.dng"), Some(other)).unwrap();
        c.set_rating("a", 4).unwrap();
        assert_eq!(c.subtree_counts(Path::new("/shoot")).unwrap(), (2, 2));
        assert_eq!(c.hide_folder(Path::new("/shoot")).unwrap(), 2, "the parent and its subfolder, not the lookalike");
        // Gone from the folder list and from catalog-wide listings...
        let listed: Vec<String> = c.folder_summaries().unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(listed, vec!["/shootout"]);
        let ids: Vec<String> = c.list_images(&Filter::default()).unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["z"]);
        // ...but the rows are all there, the folder itself still answers,
        // and the rating survived.
        assert_eq!(c.counts().unwrap().0, 3);
        assert_eq!(c.list_images(&Filter { folder_id: Some(sub), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(c.image("a").unwrap().rating, 4);
        // Browsing to it again is the unhide.
        assert_eq!(c.add_folder(Path::new("/shoot")).unwrap(), top);
        assert!(c.folder_summaries().unwrap().iter().any(|f| f.path == "/shoot"));
        assert!(!c.folder_summaries().unwrap().iter().any(|f| f.path == "/shoot/day2"), "the subfolder stays hidden until it is browsed to");
    }

    #[test]
    fn flushing_a_folder_forgets_its_rows_and_everything_hanging_off_them() {
        let c = Catalog::open_in_memory().unwrap();
        let top = c.add_folder(Path::new("/shoot")).unwrap();
        let sub = c.add_folder(Path::new("/shoot/day2")).unwrap();
        let other = c.add_folder(Path::new("/elsewhere")).unwrap();
        c.add_image("a", Path::new("/shoot/a.dng"), Some(top)).unwrap();
        c.add_image("b", Path::new("/shoot/day2/b.dng"), Some(sub)).unwrap();
        c.add_image("z", Path::new("/elsewhere/z.dng"), Some(other)).unwrap();
        c.store_thumbnail("a", ThumbKind::Embedded, &[1; 10]).unwrap();
        c.set_keywords("a", &["wedding".into()]).unwrap();
        let col = c.create_collection("picks").unwrap();
        c.add_to_collection(col, "a").unwrap();
        c.add_to_collection(col, "z").unwrap();
        assert_eq!(c.flush_folder(Path::new("/shoot")).unwrap(), (2, 2));
        assert_eq!(c.counts().unwrap(), (1, 1, 1));
        assert!(c.image("a").is_err());
        assert_eq!(c.thumbnail("a").unwrap(), None);
        assert_eq!(c.keywords_of("a").unwrap(), Vec::<String>::new());
        let members = c.list_images(&Filter { collection_id: Some(col), ..Default::default() }).unwrap();
        assert_eq!(members.len(), 1, "the collection keeps the photograph that was not flushed");
        assert_eq!(members[0].id, "z");
        // Nothing hidden about it: a flushed folder is simply not there.
        assert!(c.list_folders().unwrap().iter().all(|(_, p)| p == "/elsewhere"));
    }

    #[test]
    fn add_folder_is_idempotent_on_path() {
        let c = Catalog::open_in_memory().unwrap();
        let a = c.add_folder(Path::new("D:/photos")).unwrap();
        let b = c.add_folder(Path::new("D:/photos")).unwrap();
        assert_eq!(a, b);
        assert_eq!(c.list_folders().unwrap().len(), 1);
    }

    #[test]
    fn discovery_finds_only_supported_extensions_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("shoot1");
        std::fs::create_dir(&sub).unwrap();
        for name in ["a.dng", "b.JPG", "notes.txt", "c.cr3", "e.PEF", "f.iiq", "g.crw", "h.x3f", "i.gpr"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        std::fs::write(sub.join("d.tiff"), b"x").unwrap();
        std::fs::write(sub.join("thumbs.db"), b"x").unwrap();

        let found = discover_files(dir.path()).unwrap();
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 7, "x3f and gpr stay out: LibRaw cannot develop them");
        assert!(names.contains(&"e.PEF".to_string()), "Pentax is indexed");
        assert!(names.contains(&"f.iiq".to_string()), "Phase One is indexed");
        assert!(names.contains(&"g.crw".to_string()), "Canon CIFF is indexed");
        assert!(names.contains(&"a.dng".to_string()));
        assert!(names.contains(&"b.JPG".to_string()), "extension match is case-insensitive");
        assert!(names.contains(&"c.cr3".to_string()));
        assert!(names.contains(&"d.tiff".to_string()), "recurses into subfolders");
    }

    #[test]
    fn shallow_discovery_ignores_subfolders_and_lists_them_separately() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("060123");
        let hidden = dir.path().join(".thumbs");
        std::fs::create_dir(&sub).unwrap();
        std::fs::create_dir(&hidden).unwrap();
        std::fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("skip.txt"), b"x").unwrap();
        std::fs::write(sub.join("deep.rw2"), b"x").unwrap();

        let files = discover_files_shallow(dir.path()).unwrap();
        assert_eq!(files.len(), 1, "no recursion into subfolders");
        assert!(files[0].ends_with("a.jpg"));

        let subs = list_subfolders(dir.path()).unwrap();
        assert_eq!(subs.len(), 1, "hidden folders are skipped");
        assert!(subs[0].ends_with("060123"));

        // The recursive variant still exists for import flows.
        assert_eq!(discover_files(dir.path()).unwrap().len(), 2);
    }

    #[test]
    fn discovery_does_not_walk_into_the_trash_folder() {
        // Importing a tree would otherwise re-import the very
        // photographs the user has just taken out of the library, which
        // would look exactly like Move to Trash not working.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.dng"), b"x").unwrap();
        let trash = dir.path().join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("b.dng"), b"x").unwrap();

        let found = discover_files(dir.path()).unwrap();
        assert_eq!(found.len(), 1, "the scan walked into .trash: {found:?}");
        assert!(found[0].ends_with("a.dng"));
        // And the folder tree never offers it as somewhere to browse.
        assert!(list_subfolders(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn discovery_skips_appledouble_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.dng"), b"x").unwrap();
        std::fs::write(dir.path().join("._a.dng"), b"resource fork").unwrap();

        let found = discover_files(dir.path()).unwrap();
        assert_eq!(found.len(), 1, "the sidecar's extension does not make it an image");
        assert!(found[0].ends_with("a.dng"));

        let shallow = discover_files_shallow(dir.path()).unwrap();
        assert_eq!(shallow.len(), 1);
        assert!(shallow[0].ends_with("a.dng"));
    }

    #[test]
    fn batch_commits_on_success_and_rolls_back_on_error() {
        let c = Catalog::open_in_memory().unwrap();
        c.batch(|c| {
            c.add_image("img_1", Path::new("D:/p/a.dng"), None)?;
            c.add_image("img_2", Path::new("D:/p/b.dng"), None)?;
            Ok(())
        })
        .unwrap();
        assert_eq!(c.list_images(&Filter::default()).unwrap().len(), 2);

        let err = c.batch(|c| {
            c.add_image("img_3", Path::new("D:/p/c.dng"), None)?;
            c.set_rating("ghost", 3) // fails: whole batch rolls back
        });
        assert!(err.is_err());
        assert_eq!(c.list_images(&Filter::default()).unwrap().len(), 2, "rolled back");
    }

    #[test]
    fn image_record_round_trips() {
        let c = catalog_with_images();
        let img = c.image("img_2").unwrap();
        assert_eq!(img.file_name, "bbb.jpg");
        assert_eq!(img.extension, "jpg");
        assert_eq!(img.rating, 0);
        assert_eq!(img.flag, Flag::None);
        assert!(img.added_at > 0);
    }

    #[test]
    fn duplicate_image_path_rejected() {
        let c = catalog_with_images();
        assert!(c.add_image("img_9", Path::new("D:/photos/aaa.dng"), None).is_err());
    }

    #[test]
    fn rating_validates_and_persists() {
        let c = catalog_with_images();
        c.set_rating("img_1", 5).unwrap();
        assert_eq!(c.image("img_1").unwrap().rating, 5);
        assert!(matches!(c.set_rating("img_1", 6), Err(CatalogError::InvalidRating(6))));
        assert!(matches!(
            c.set_rating("ghost", 3),
            Err(CatalogError::ImageNotFound(_))
        ));
    }

    #[test]
    fn flags_persist() {
        let c = catalog_with_images();
        c.set_flag("img_1", Flag::Pick).unwrap();
        c.set_flag("img_2", Flag::Reject).unwrap();
        assert_eq!(c.image("img_1").unwrap().flag, Flag::Pick);
        assert_eq!(c.image("img_2").unwrap().flag, Flag::Reject);
    }

    #[test]
    fn filters_combine_with_and() {
        let c = catalog_with_images();
        c.set_rating("img_1", 4).unwrap();
        c.set_rating("img_3", 2).unwrap();
        c.set_flag("img_1", Flag::Pick).unwrap();

        let dng_only = c
            .list_images(&Filter {
                extension: Some("dng".into()),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(dng_only.len(), 2);

        let rated_dng = c
            .list_images(&Filter {
                extension: Some("dng".into()),
                min_rating: Some(3),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(rated_dng.len(), 1);
        assert_eq!(rated_dng[0].id, "img_1");

        let picked = c
            .list_images(&Filter {
                flag: Some(Flag::Pick),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(picked.len(), 1);
    }

    #[test]
    fn list_is_ordered_by_file_name() {
        let c = catalog_with_images();
        let all = c.list_images(&Filter::default()).unwrap();
        let names: Vec<&str> = all.iter().map(|i| i.file_name.as_str()).collect();
        assert_eq!(names, vec!["aaa.dng", "bbb.jpg", "ccc.dng"]);
    }

    #[test]
    fn collections_support_multi_membership() {
        let c = catalog_with_images();
        let wedding = c.create_collection("Wedding 2026").unwrap();
        let picks = c.create_collection("Portfolio Picks").unwrap();
        c.add_to_collection(wedding, "img_1").unwrap();
        c.add_to_collection(wedding, "img_2").unwrap();
        c.add_to_collection(picks, "img_1").unwrap();
        c.add_to_collection(picks, "img_1").unwrap(); // idempotent

        let in_wedding = c
            .list_images(&Filter {
                collection_id: Some(wedding),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(in_wedding.len(), 2);

        let in_picks = c
            .list_images(&Filter {
                collection_id: Some(picks),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(in_picks.len(), 1);
        assert_eq!(in_picks[0].id, "img_1");

        c.remove_from_collection(wedding, "img_2").unwrap();
        assert_eq!(
            c.list_images(&Filter {
                collection_id: Some(wedding),
                ..Filter::default()
            })
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn collection_graph_id_marks_a_look() {
        let c = catalog_with_images();
        let id = c.create_collection("Wedding 2026").unwrap();
        c.set_collection_graph(id, Some("col_wedding_2026")).unwrap();
        let cols = c.list_collections().unwrap();
        assert_eq!(cols[0].graph_id.as_deref(), Some("col_wedding_2026"));
        c.set_collection_graph(id, None).unwrap();
        assert_eq!(c.list_collections().unwrap()[0].graph_id, None);
    }

    #[test]
    fn thumbnail_upsert_replaces_embedded_with_rendered() {
        let c = catalog_with_images();
        assert!(c.thumbnail("img_1").unwrap().is_none());
        c.store_thumbnail("img_1", ThumbKind::Embedded, b"fast").unwrap();
        let (kind, data) = c.thumbnail("img_1").unwrap().unwrap();
        assert_eq!(kind, ThumbKind::Embedded);
        assert_eq!(data, b"fast");

        c.store_thumbnail("img_1", ThumbKind::Rendered, b"accurate").unwrap();
        let (kind, data) = c.thumbnail("img_1").unwrap().unwrap();
        assert_eq!(kind, ThumbKind::Rendered);
        assert_eq!(data, b"accurate");

        c.clear_thumbnail("img_1").unwrap();
        assert!(c.thumbnail("img_1").unwrap().is_none());
    }

    #[test]
    fn remove_image_cascades_memberships_and_thumbnails() {
        let c = catalog_with_images();
        let col = c.create_collection("Set").unwrap();
        c.add_to_collection(col, "img_1").unwrap();
        c.store_thumbnail("img_1", ThumbKind::Embedded, b"t").unwrap();

        c.remove_image("img_1").unwrap();
        assert!(matches!(c.image("img_1"), Err(CatalogError::ImageNotFound(_))));
        assert!(c.thumbnail("img_1").unwrap().is_none());
        assert_eq!(
            c.list_images(&Filter {
                collection_id: Some(col),
                ..Filter::default()
            })
            .unwrap()
            .len(),
            0
        );
        assert!(matches!(c.remove_image("img_1"), Err(CatalogError::ImageNotFound(_))));
    }

    #[test]
    fn relinking_keeps_the_id_so_the_edits_come_with_it() {
        // The id keys the saved graph, the thumbnail cache, the keywords
        // and every collection membership. A moved file that came back
        // as a new row would be a stranger wearing the same picture,
        // with the edits sitting on an id nothing points at any more.
        let c = catalog_with_images();
        let old = Path::new("D:/photos/aaa.dng");
        let moved = Path::new("E:/archive/2024/aaa.dng");
        c.set_rating("img_1", 5).unwrap();
        c.set_keywords("img_1", &["wedding".into()]).unwrap();
        let folder = c.add_folder(Path::new("E:/archive/2024")).unwrap();

        c.set_image_path("img_1", moved, Some(folder)).unwrap();

        let rec = c.image("img_1").unwrap();
        assert_eq!(rec.path, moved.to_string_lossy());
        assert_eq!(rec.folder_id, Some(folder));
        assert_eq!(rec.rating, 5, "the rating did not come with it");
        assert_eq!(c.keywords_of("img_1").unwrap(), vec!["wedding"]);
        // And nothing answers to the old path any more, so a rescan of
        // the old folder cannot resurrect a second row for it.
        assert_eq!(c.image_id_by_path(old).unwrap(), None);
        assert_eq!(c.image_id_by_path(moved).unwrap(), Some("img_1".to_string()));
    }

    /// Forget Missing Trashed Photos (2026-10-01: "yes, build the purge"):
    /// only a row still trashed goes, with what hangs off it.
    #[test]
    fn forgetting_trashed_photographs_takes_only_trashed_rows_and_their_records() {
        let c = catalog_with_images();
        c.set_keywords("img_1", &["gone".into()]).unwrap();
        c.set_trashed("img_1", true).unwrap();
        c.set_keywords("img_2", &["kept".into()]).unwrap();
        let ids = vec!["img_1".to_string(), "img_2".to_string(), "nobody".to_string()];
        assert_eq!(c.forget_trashed_images(&ids).unwrap(), 1);
        assert!(c.image("img_1").is_err());
        assert!(c.keywords_of("img_1").unwrap().is_empty());
        assert_eq!(c.image("img_2").unwrap().id, "img_2");
        assert_eq!(c.keywords_of("img_2").unwrap(), vec!["kept"]);
        assert!(c.image("img_3").is_ok());
    }

    #[test]
    fn a_trashed_photograph_leaves_the_library_without_becoming_a_hidden_one() {
        let c = catalog_with_images();
        c.set_hidden("img_2", true).unwrap();
        c.set_trashed("img_1", true).unwrap();

        let all = |include_hidden| {
            c.list_images(&Filter { include_hidden, ..Default::default() })
                .unwrap()
                .into_iter()
                .map(|r| r.id)
                .collect::<Vec<_>>()
        };
        // Gone from the ordinary listing, and gone from the one that
        // deliberately asks for everything hidden as well. There is no
        // flag that lets it back in, because its file is not where the
        // row says it is.
        assert_eq!(all(false), vec!["img_3"]);
        assert_eq!(all(true), vec!["img_2", "img_3"]);

        // The rating survives the trip, because the trip is a rename.
        c.set_rating("img_1", 4).unwrap();
        c.set_trashed("img_1", false).unwrap();
        assert_eq!(all(false), vec!["img_1", "img_3"]);
        assert_eq!(c.image("img_1").unwrap().rating, 4);
    }

    #[test]
    fn recovering_hidden_photographs_does_not_reach_into_the_trash() {
        // The reason `trashed` is its own column. Both states mean "not
        // in the library", so sharing a column would have made Recover
        // Hidden resurrect a row whose photograph had moved out from
        // under it: an entry in the ribbon pointing at nothing.
        let c = Catalog::open_in_memory().unwrap();
        let folder = c.add_folder(Path::new("D:/photos")).unwrap();
        c.add_image("img_1", Path::new("D:/photos/aaa.dng"), Some(folder)).unwrap();
        c.add_image("img_2", Path::new("D:/photos/bbb.jpg"), Some(folder)).unwrap();
        c.set_hidden("img_1", true).unwrap();
        c.set_trashed("img_2", true).unwrap();

        assert_eq!(c.hidden_count(Path::new("D:/photos")).unwrap(), 1);
        assert_eq!(c.trashed_count(Path::new("D:/photos")).unwrap(), 1);
        assert_eq!(c.recover_hidden(Path::new("D:/photos")).unwrap(), 1);
        assert!(c.is_trashed("img_2").unwrap(), "recovery took a trashed photograph with it");

        let trashed = c.list_trashed(None).unwrap();
        assert_eq!(trashed.len(), 1);
        // Where it came from and where Put Back returns it, not where
        // the file is sitting now.
        assert_eq!(trashed[0].path, "D:/photos/bbb.jpg");
    }

    #[test]
    fn keywords_round_trip_filter_and_die_with_the_image() {
        let c = catalog_with_images();
        c.set_keywords("img_1", &["Wedding".into(), "  smith-family ".into(), "".into()])
            .unwrap();
        // Trimmed, sorted case-insensitively (the column's collation),
        // empties dropped.
        assert_eq!(c.keywords_of("img_1").unwrap(), vec!["smith-family", "Wedding"]);
        // Case folds: filtering by "wedding" finds "Wedding".
        let hits = c
            .list_images(&Filter {
                min_rating: None,
                flag: None,
                extension: None,
                folder_id: None,
                collection_id: None,
                keyword: Some("wedding".into()),
                include_hidden: false,
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "img_1");
        // Set semantics: the next set replaces, not appends.
        c.set_keywords("img_1", &["portraits".into()]).unwrap();
        assert_eq!(c.keywords_of("img_1").unwrap(), vec!["portraits"]);
        assert_eq!(c.all_keywords().unwrap(), vec!["portraits"]);
        // Removing the image takes its keywords with it.
        c.remove_image("img_1").unwrap();
        assert!(c.all_keywords().unwrap().is_empty());
    }

    #[test]
    fn remove_image_clears_the_camera_cache_too() {
        // The exif table references the image with foreign keys
        // enforced; forgetting it in the delete made removing any
        // image whose camera data had been cached fail on the
        // constraint.
        let c = catalog_with_images();
        c.put_exif("img_1", &ExifRecord { iso: Some(100), ..ExifRecord::default() }, 1)
            .unwrap();
        c.remove_image("img_1").unwrap();
        assert!(matches!(c.image("img_1"), Err(CatalogError::ImageNotFound(_))));
        assert_eq!(c.exif("img_1").unwrap(), None);
    }

    #[test]
    fn folder_summaries_order_by_recency_with_counts() {
        let c = Catalog::open_in_memory().unwrap();
        let a = c.add_folder(Path::new("D:/photos/alpha")).unwrap();
        let b = c.add_folder(Path::new("D:/photos/beta")).unwrap();
        c.add_image("img_1", Path::new("D:/photos/alpha/a.dng"), Some(a)).unwrap();
        c.add_image("img_2", Path::new("D:/photos/alpha/b.dng"), Some(a)).unwrap();
        c.add_image("img_3", Path::new("D:/photos/beta/c.jpg"), Some(b)).unwrap();

        // Never opened: path order, counts correct.
        let list = c.folder_summaries().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].image_count, 2);
        assert_eq!(list[1].image_count, 1);

        // Opening beta promotes it to the top.
        c.touch_folder(b).unwrap();
        let list = c.folder_summaries().unwrap();
        assert_eq!(list[0].path, "D:/photos/beta");
        assert!(list[0].last_opened > 0);
    }

    // Hiding ----------------------------------------------------------

    /// The owner asked for hiding to be reversible, so the thing that
    /// makes it reversible is the thing to pin down: hiding must not
    /// touch a single other column.
    #[test]
    fn hiding_keeps_everything_it_is_not_about() {
        let c = catalog_with_images();
        c.set_rating("img_1", 4).unwrap();
        c.set_flag("img_1", Flag::Pick).unwrap();
        c.set_edited("img_1").unwrap();
        let set = c.create_collection("Set").unwrap();
        c.add_to_collection(set, "img_1").unwrap();

        c.set_hidden("img_1", true).unwrap();
        assert!(c.is_hidden("img_1").unwrap());
        // The record is still all there, which is what lets unhiding give
        // back the photograph rather than a stranger with the same name.
        let rec = c.image("img_1").unwrap();
        assert_eq!(rec.rating, 4);
        assert_eq!(rec.flag, Flag::Pick);
        assert!(rec.edited);
        assert_eq!(c.collection_summaries().unwrap()[0].image_count, 1);

        c.set_hidden("img_1", false).unwrap();
        let rec = c.image("img_1").unwrap();
        assert_eq!(rec.rating, 4);
        assert_eq!(rec.flag, Flag::Pick);
    }

    /// A hidden image is out of every ordinary listing. If it could leak
    /// back through some filter combination nobody remembered to guard,
    /// hiding would not mean anything.
    #[test]
    fn hidden_images_stay_out_of_listings() {
        let c = catalog_with_images();
        c.set_rating("img_1", 5).unwrap();
        c.set_flag("img_1", Flag::Pick).unwrap();
        c.set_hidden("img_1", true).unwrap();

        let ids = |f: &Filter| {
            c.list_images(f).unwrap().into_iter().map(|i| i.id).collect::<Vec<_>>()
        };
        assert_eq!(ids(&Filter::default()), vec!["img_2", "img_3"]);
        // Not through a rating filter it would top, nor a flag filter,
        // nor an extension filter.
        assert!(ids(&Filter { min_rating: Some(5), ..Default::default() }).is_empty());
        assert!(ids(&Filter { flag: Some(Flag::Pick), ..Default::default() }).is_empty());
        assert_eq!(
            ids(&Filter { extension: Some("dng".into()), ..Default::default() }),
            vec!["img_3"]
        );
        // And it comes back the moment it is asked for by name.
        assert_eq!(ids(&Filter { include_hidden: true, ..Default::default() }).len(), 3);
    }

    /// "The dialog will tell the user how many they are about to unhide
    /// and confirm", so the count has to be right before anything moves.
    #[test]
    fn recover_hidden_counts_and_unhides_one_folder() {
        let c = Catalog::open_in_memory().unwrap();
        let alpha = c.add_folder(Path::new("D:/photos/alpha")).unwrap();
        let beta = c.add_folder(Path::new("D:/photos/beta")).unwrap();
        for (id, folder) in
            [("a1", alpha), ("a2", alpha), ("a3", alpha), ("b1", beta), ("b2", beta)]
        {
            let p = format!("D:/photos/{id}.dng");
            c.add_image(id, Path::new(&p), Some(folder)).unwrap();
        }
        for id in ["a1", "a2", "b1"] {
            c.set_hidden(id, true).unwrap();
        }

        assert_eq!(c.hidden_count(Path::new("D:/photos/alpha")).unwrap(), 2);
        assert_eq!(c.hidden_count(Path::new("D:/photos/beta")).unwrap(), 1);
        assert_eq!(
            c.folders_with_hidden().unwrap(),
            vec!["D:/photos/alpha".to_string(), "D:/photos/beta".to_string()]
        );

        // Recovering one folder leaves the other alone.
        assert_eq!(c.recover_hidden(Path::new("D:/photos/alpha")).unwrap(), 2);
        assert_eq!(c.hidden_count(Path::new("D:/photos/alpha")).unwrap(), 0);
        assert_eq!(c.hidden_count(Path::new("D:/photos/beta")).unwrap(), 1);
        assert_eq!(c.folders_with_hidden().unwrap(), vec!["D:/photos/beta".to_string()]);
        // Doing it twice is not an error, it just recovers nothing.
        assert_eq!(c.recover_hidden(Path::new("D:/photos/alpha")).unwrap(), 0);
    }

    /// The catalogs people already have have to survive the new column.
    #[test]
    fn upgrading_from_v6_hides_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        {
            let conn = raw_open(&path).unwrap();
            for m in [
                MIGRATION_V1,
                MIGRATION_V2,
                MIGRATION_V3,
                MIGRATION_V4,
                MIGRATION_V5,
                MIGRATION_V6,
            ] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 6).unwrap();
            conn.execute(
                "INSERT INTO images (id, path, file_name, extension, added_at, rating)
                 VALUES ('old', 'D:/p/old.dng', 'old.dng', 'dng', 1, 3)",
                [],
            )
            .unwrap();
        }
        let c = Catalog::open(&path).unwrap();
        // Everything an existing user has stays visible and keeps its rating.
        let list = c.list_images(&Filter::default()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].rating, 3);
        assert!(!c.is_hidden("old").unwrap());
    }

    /// A catalog file stopped at v6, one image and one thumbnail in it:
    /// the pre-upgrade prompt's fixture.
    fn v6_catalog(path: &Path) {
        let conn = raw_open(path).unwrap();
        for m in [
            MIGRATION_V1,
            MIGRATION_V2,
            MIGRATION_V3,
            MIGRATION_V4,
            MIGRATION_V5,
            MIGRATION_V6,
        ] {
            conn.execute_batch(m).unwrap();
        }
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn.execute(
            "INSERT INTO images (id, path, file_name, extension, added_at, rating)
             VALUES ('old', 'D:/p/old.dng', 'old.dng', 'dng', 1, 3)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO thumbnails (image_id, kind, data, updated_at)
             VALUES ('old', 'embedded', X'01020304', 1)",
            [],
        )
        .unwrap();
    }

    /// The update prompt's probe (26.3): only an older, real catalog is
    /// pending; nothing is opened for write and nothing migrates.
    #[test]
    fn pending_upgrade_names_only_an_older_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        v6_catalog(&path);
        assert_eq!(Catalog::pending_upgrade(&path).unwrap(), Some((6, SCHEMA_VERSION)));
        // The probe alone changed nothing: the file still reads v6.
        let check = raw_open(&path).unwrap();
        let v: i64 = check.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 6);

        // A current catalog is not pending.
        let current = dir.path().join("current.sqlite");
        drop(Catalog::open(&current).unwrap());
        assert_eq!(Catalog::pending_upgrade(&current).unwrap(), None);

        // Newer is refused as newer, a foreign file as not a catalog.
        let future = dir.path().join("future.sqlite");
        drop(Catalog::open(&future).unwrap());
        raw_open(&future).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        assert!(matches!(Catalog::pending_upgrade(&future), Err(CatalogError::SchemaVersion(_))));
        let blank = dir.path().join("blank.sqlite");
        drop(raw_open(&blank).unwrap());
        assert!(matches!(Catalog::pending_upgrade(&blank), Err(CatalogError::NotACatalog(_))));
    }

    /// The backup the prompt offers (26.3): a copy of the UNOPENED file,
    /// schema version and thumbnails rules intact, never overwriting.
    #[test]
    fn restore_snapshot_preserves_old_schema_and_source_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("old.sqlite");
        let dest = dir.path().join("catalog.restoring");
        v6_catalog(&source);
        let before = std::fs::read(&source).unwrap();
        restore_copy_unopened(&source, &dest, None).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_eq!(Catalog::pending_upgrade(&dest).unwrap(), Some((6, SCHEMA_VERSION)));
        let open = |p: &Path| Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let schema = |c: &Connection| c.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
            .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(schema(&open(&source)), schema(&open(&dest)));
    }

    #[test]
    fn snapshot_unopened_copies_without_migrating() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        v6_catalog(&path);

        let dest = dir.path().join("catalog.before-test.sqlite");
        let report = Catalog::snapshot_unopened(&path, &dest, false).unwrap();
        assert_eq!(report.images, 1);
        assert_eq!(report.thumbnails_dropped, 1);
        // The copy is still v6: an older Heeler can open it, and this
        // build's recovery read names it old rather than newer.
        let copy = raw_open(&dest).unwrap();
        let v: i64 = copy.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 6);
        drop(copy);
        assert!(matches!(Catalog::recovery_inventory(&dest), Err(CatalogError::SchemaTooOld(6))));
        // And the source is untouched: still v6, migrates only when
        // actually opened.
        let src = raw_open(&path).unwrap();
        let sv: i64 = src.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(sv, 6);
        drop(src);

        // A taken name is refused, not replaced.
        assert!(matches!(
            Catalog::snapshot_unopened(&path, &dest, false),
            Err(CatalogError::BackupExists(_))
        ));

        // Asked to keep them, the thumbnails make the trip.
        let full = dir.path().join("catalog.full.sqlite");
        let report = Catalog::snapshot_unopened(&path, &full, true).unwrap();
        assert_eq!(report.thumbnails_dropped, 0);
        let copy = raw_open(&full).unwrap();
        let thumbs: i64 = copy.query_row("SELECT count(*) FROM thumbnails", [], |r| r.get(0)).unwrap();
        assert_eq!(thumbs, 1);
    }

    /// v17: the folder listing reads its rows in file-name order off the
    /// composite index instead of sorting them, on a fresh catalog and on
    /// one migrated up from v16 alike.
    #[test]
    fn v17_indexes_the_folder_listing() {
        let c = Catalog::open_in_memory().unwrap();
        let present: bool = c.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_images_folder_name')",
            [], |r| r.get(0)).unwrap();
        assert!(present, "the composite index exists on a fresh catalog");
        let plan: Vec<String> = c.conn
            .prepare("EXPLAIN QUERY PLAN SELECT id FROM images i WHERE i.folder_id = 1 ORDER BY i.file_name, i.id").unwrap()
            .query_map([], |r| r.get::<_, String>(3)).unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(plan.iter().any(|l| l.contains("idx_images_folder_name")), "the listing uses the index: {plan:?}");
        assert!(!plan.iter().any(|l| l.contains("USE TEMP B-TREE FOR ORDER BY")), "no sort step: {plan:?}");
        // Migrated from v16: the index arrives with the migration.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..16] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 16).unwrap();
        }
        assert_eq!(Catalog::pending_upgrade(&path).unwrap(), Some((16, SCHEMA_VERSION)));
        let migrated = Catalog::open(&path).unwrap();
        assert_eq!(migrated.migration_span(), Some((16, SCHEMA_VERSION)));
        let present: bool = migrated.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_images_folder_name')",
            [], |r| r.get(0)).unwrap();
        assert!(present, "the migration built the index");
    }

    /// v18: a full decode's size beside the header's, per source key, on
    /// a fresh catalog and one migrated up from v17; removing the image
    /// or flushing its folder takes the rows with it (foreign keys are
    /// enforced, so a leftover row would fail the delete).
    #[test]
    fn v18_keeps_decoded_dimensions_beside_the_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..17] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 17).unwrap();
        }
        assert_eq!(Catalog::pending_upgrade(&path).unwrap(), Some((17, 18)));
        let c = Catalog::open(&path).unwrap();
        assert_eq!(c.migration_span(), Some((17, 18)));
        let folder = c.add_folder(dir.path()).unwrap();
        let id = "img_decoded".to_string();
        c.add_image(&id, &dir.path().join("P1.RW2"), Some(folder)).unwrap();
        c.set_dimensions(&id, 6000, 4000).unwrap();
        assert_eq!(c.decoded_dimensions(&id, "wb|len 3").unwrap(), None);
        c.set_decoded_dimensions(&id, "wb|len 3", 6024, 4016).unwrap();
        assert_eq!(c.decoded_dimensions(&id, "wb|len 3").unwrap(), Some((6024, 4016)));
        assert_eq!(c.decoded_dimensions(&id, "nowb|len 3").unwrap(), None, "another source key is another decode");
        let rec = c.image(&id).unwrap();
        assert_eq!((rec.width, rec.height), (Some(6000), Some(4000)), "the header stays for the listing");
        c.remove_image(&id).unwrap();
        assert_eq!(c.decoded_dimensions(&id, "wb|len 3").unwrap(), None);
        // The folder flush takes them too.
        c.add_image(&id, &dir.path().join("P1.RW2"), Some(folder)).unwrap();
        c.set_decoded_dimensions(&id, "wb|len 3", 6024, 4016).unwrap();
        c.flush_folder(dir.path()).unwrap();
        assert_eq!(c.decoded_dimensions(&id, "wb|len 3").unwrap(), None);
    }

    #[test]
    fn a_v17_catalog_with_rows_is_gated_and_snapshotted_before_v18() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v17.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..17] { conn.execute_batch(m).unwrap(); }
            conn.pragma_update(None, "user_version", 17).unwrap();
            conn.execute("INSERT INTO images(id,path,file_name,extension,added_at) VALUES('own','/own.dng','own.dng','dng',0)", []).unwrap();
        }
        let before = counts_unopened(&path).unwrap();
        assert_eq!(before.0, 1);
        assert_eq!(Catalog::pending_upgrade(&path).unwrap(), Some((17, 18)));
        let backup = dir.path().join("before.sqlite");
        Catalog::snapshot_unopened(&path, &backup, false).unwrap();
        assert_eq!(Catalog::pending_upgrade(&backup).unwrap(), Some((17, 18)));
        let upgraded = Catalog::open(&path).unwrap();
        assert_eq!(upgraded.counts().unwrap(), before);
        assert_eq!(upgraded.migration_span(), Some((17, 18)));
        assert_eq!(counts_unopened(&backup).unwrap(), before);
    }

    #[test]
    fn decoded_dimensions_survive_trash_and_a_backup_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("own.sqlite");
        let c = Catalog::open(&path).unwrap();
        let folder = c.add_folder(dir.path()).unwrap();
        c.add_image("own", &dir.path().join("own.dng"), Some(folder)).unwrap();
        c.set_decoded_dimensions("own", "own-source", 6024, 4016).unwrap();
        c.set_trashed("own", true).unwrap();
        assert_eq!(c.decoded_dimensions("own", "own-source").unwrap(), Some((6024, 4016)));
        let snapshot = dir.path().join("backup.sqlite");
        c.backup_to(&snapshot, false).unwrap();
        let restored = Catalog::open(&snapshot).unwrap();
        assert!(restored.is_trashed("own").unwrap());
        restored.set_trashed("own", false).unwrap();
        assert_eq!(restored.decoded_dimensions("own", "own-source").unwrap(), Some((6024, 4016)));
        assert!(!restored.is_trashed("own").unwrap());
    }

    #[test]
    fn open_signs_written_by() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        let c = Catalog::open(&path).unwrap();
        assert_eq!(c.meta("written_by").unwrap().as_deref(), Some(env!("CARGO_PKG_VERSION")));
        drop(c);
        // An older file upgraded by the open is signed too.
        let old = dir.path().join("old.sqlite");
        v6_catalog(&old);
        let c = Catalog::open(&old).unwrap();
        assert_eq!(c.meta("written_by").unwrap().as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }

    // Catalog management -----------------------------------------------

    /// The numbers behind the advice: thumbnails dominate the file and
    /// are the one part that can be rebuilt from the RAWs.
    #[test]
    fn stats_separate_the_regenerable_from_the_irreplaceable() {
        let c = catalog_with_images();
        c.store_thumbnail("img_1", ThumbKind::Embedded, &vec![7u8; 40_000]).unwrap();
        c.set_hidden("img_2", true).unwrap();
        let s = c.stats().unwrap();
        assert_eq!(s.images, 3);
        assert_eq!(s.thumbnails, 1);
        assert_eq!(s.hidden, 1);
        assert_eq!(s.thumbnail_bytes, 40_000);
        assert!(s.total_bytes > s.thumbnail_bytes);
        assert_eq!(s.irreplaceable_bytes(), s.total_bytes - 40_000);
    }

    #[test]
    fn clearing_the_thumbnails_keeps_the_work_and_shrinks_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        let c = Catalog::open(&path).unwrap();
        c.add_image("img_1", Path::new("D:/photos/aaa.dng"), None).unwrap();
        c.add_image("img_2", Path::new("D:/photos/bbb.dng"), None).unwrap();
        c.set_rating("img_1", 4).unwrap();
        c.store_thumbnail("img_1", ThumbKind::Embedded, &vec![3u8; 200_000]).unwrap();
        c.store_thumbnail("img_2", ThumbKind::Rendered, &vec![4u8; 200_000]).unwrap();
        let before = c.stats().unwrap();
        assert_eq!(before.thumbnails, 2);

        assert_eq!(c.clear_thumbnails().unwrap(), 2);
        let after = c.stats().unwrap();
        assert_eq!(after.thumbnails, 0);
        assert_eq!(after.thumbnail_bytes, 0);
        assert!(after.total_bytes < before.total_bytes, "the file must shrink: {} vs {}", after.total_bytes, before.total_bytes);
        assert_eq!(after.images, 2, "the photographs stay");
        assert_eq!(c.image("img_1").unwrap().rating, 4, "and so does the work");
        assert!(c.thumbnail("img_1").unwrap().is_none());
        // Cleared twice is zero, not an error.
        assert_eq!(c.clear_thumbnails().unwrap(), 0);
    }

    #[test]
    fn a_backup_drops_the_thumbnails_but_keeps_the_work() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog::open(&dir.path().join("catalog.sqlite")).unwrap();
        c.add_image("img_1", Path::new("D:/photos/aaa.dng"), None).unwrap();
        c.set_rating("img_1", 5).unwrap();
        c.set_hidden("img_1", true).unwrap();
        c.store_thumbnail("img_1", ThumbKind::Embedded, &vec![3u8; 200_000]).unwrap();

        // Explicit backups can create a new destination directory.
        let dest = dir.path().join("backups").join("catalog-backup.sqlite");
        let report = c.backup_to(&dest, false).unwrap();
        assert_eq!(report.images, 1);
        assert_eq!(report.thumbnails_dropped, 1);
        // Smaller than the one thumbnail it left behind, which is the point.
        assert!(report.bytes < 200_000, "backup was {} bytes", report.bytes);

        // And it is a working catalog with the metadata intact.
        let restored = Catalog::open(&dest).unwrap();
        assert_eq!(restored.image("img_1").unwrap().rating, 5);
        assert!(restored.is_hidden("img_1").unwrap());
        assert_eq!(restored.stats().unwrap().thumbnails, 0);
    }

    #[test]
    fn opening_an_existing_catalog_refuses_foreign_files_without_modifying_them() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("foreign.sqlite");
        let foreign = raw_open(&path).unwrap();
        foreign.execute_batch("CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES ('keep');").unwrap();
        drop(foreign);
        let before = std::fs::read(&path).unwrap();
        assert!(matches!(Catalog::open_existing(&path), Err(CatalogError::NotACatalog(_))));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let old = d.path().join("old.sqlite");
        let conn = raw_open(&old).unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        drop(conn);
        assert_eq!(Catalog::open_existing(&old).unwrap().counts().unwrap().0, 0);
    }

    /// A negative user_version used to index the migration list as a
    /// huge usize and panic. It is not a catalog, said without dying.
    #[test]
    fn a_negative_schema_version_is_refused_not_a_panic() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("negative.sqlite");
        drop(Catalog::open(&path).unwrap());
        // Written through SQLite rather than by patching the header
        // bytes: rewriting a database file from outside makes the next
        // open's moved-file check fire on exFAT, and this test is about
        // the version, not the drive.
        raw_open(&path).unwrap().pragma_update(None, "user_version", -1).unwrap();
        assert!(matches!(Catalog::open(&path), Err(CatalogError::NotACatalog(_))));
        assert!(matches!(Catalog::open_existing(&path), Err(CatalogError::NotACatalog(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_backup_refuses_a_dangling_destination_link() {
        let d = tempfile::tempdir().unwrap();
        let dest = d.path().join("link.sqlite");
        let missing = d.path().join("missing.sqlite");
        std::os::unix::fs::symlink(&missing, &dest).unwrap();
        let c = Catalog::open_in_memory().unwrap();
        assert!(c.backup_to(&dest, false).is_err());
        assert!(!missing.exists());
        assert!(std::fs::symlink_metadata(dest).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_backup_never_writes_over_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog::open(&dir.path().join("catalog.sqlite")).unwrap();
        let dest = dir.path().join("taken.sqlite");
        std::fs::write(&dest, b"last week").unwrap();
        assert!(matches!(c.backup_to(&dest, false), Err(CatalogError::BackupExists(_))));
        // Untouched, which is the whole reason to refuse.
        assert_eq!(std::fs::read(&dest).unwrap(), b"last week");
    }

    #[test]
    fn a_copy_wears_the_backup_name_only_once_it_is_complete() {
        let d = tempfile::tempdir_in("/tmp").unwrap();
        let c = Catalog::open(&d.path().join("catalog.sqlite")).unwrap();
        c.add_image("img_1", Path::new("/photos/1.dng"), None).unwrap();
        let dest = d.path().join("copy.sqlite");
        assert_eq!(partial_backup_path(&dest), d.path().join("copy.sqlite.partial"));
        // A copy that fails halfway (VACUUM inside a transaction is
        // refused) leaves only the .partial file: the backup's own name
        // is never attached to something that is not a backup.
        c.batch(|c| {
            assert!(c.backup_to_existing_folder(&dest, false).is_err());
            Ok(())
        }).unwrap();
        assert!(!dest.exists(), "no file wears the backup's name");
        assert!(partial_backup_path(&dest).is_file(), "the leftover is labeled partial");
        // A stale leftover under the same name is refused, never overwritten.
        assert!(matches!(c.backup_to_existing_folder(&dest, false), Err(CatalogError::BackupExists(_))));
        // A completed copy is renamed into place and leaves no .partial.
        let other = d.path().join("other.sqlite");
        let report = c.backup_to_existing_folder(&other, false).unwrap();
        assert_eq!(report.path, other.to_string_lossy());
        assert!(other.is_file());
        assert!(!partial_backup_path(&other).exists());
        assert_eq!(Catalog::open_existing(&other).unwrap().counts().unwrap().0, 1);
    }

    #[test]
    fn a_scheduled_copy_never_creates_parent_folders_but_an_explicit_copy_can() {
        let d = tempfile::tempdir_in("/tmp").unwrap();
        let c = Catalog::open(&d.path().join("catalog.sqlite")).unwrap();
        let dest = d.path().join("unavailable/backups/copy.sqlite");
        assert!(c.backup_to_existing_folder(&dest, false).is_err());
        assert!(!d.path().join("unavailable").exists());
        c.backup_to(&dest, false).unwrap();
        assert!(Catalog::open_existing(&dest).is_ok());
    }

    #[test]
    fn keeping_the_thumbnails_is_there_for_anyone_who_wants_it() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog::open(&dir.path().join("catalog.sqlite")).unwrap();
        c.add_image("img_1", Path::new("D:/photos/aaa.dng"), None).unwrap();
        c.store_thumbnail("img_1", ThumbKind::Embedded, &vec![3u8; 5_000]).unwrap();
        let dest = dir.path().join("full.sqlite");
        let report = c.backup_to(&dest, true).unwrap();
        assert_eq!(report.thumbnails_dropped, 0);
        assert_eq!(Catalog::open(&dest).unwrap().stats().unwrap().thumbnails, 1);
    }

    /// A backup taken while the catalog is being written has to be a
    /// consistent snapshot, which is why this is VACUUM INTO and not a
    /// file copy.
    #[test]
    fn a_backup_of_a_live_catalog_is_consistent() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog::open(&dir.path().join("catalog.sqlite")).unwrap();
        for i in 0..200 {
            let p = format!("D:/photos/{i}.dng");
            c.add_image(&format!("img_{i}"), Path::new(&p), None).unwrap();
        }
        // A second writer has an uncommitted rating in the WAL.
        let writer = raw_open(dir.path().join("catalog.sqlite")).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE; UPDATE images SET rating=5 WHERE id='img_0';").unwrap();
        let dest = dir.path().join("live.sqlite");
        let report = c.backup_to(&dest, false).unwrap();
        assert_eq!(report.images, 200);
        let snapshot = Catalog::open(&dest).unwrap();
        assert_eq!(snapshot.counts().unwrap().0, 200);
        assert_eq!(snapshot.image("img_0").unwrap().rating, 0);
        writer.execute_batch("COMMIT").unwrap();
        let after = dir.path().join("after.sqlite");
        c.backup_to(&after, false).unwrap();
        assert_eq!(Catalog::open(&after).unwrap().image("img_0").unwrap().rating, 5);
    }

    #[test]
    fn a_backup_stays_consistent_when_a_writer_commits_during_the_snapshot() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let d = tempfile::tempdir_in("/tmp").unwrap();
        let source = d.path().join("catalog.sqlite");
        let c = Catalog::open(&source).unwrap();
        c.batch(|c| {
            for i in 0..1000 {
                c.add_image(&format!("img_{i}"), Path::new(&format!("/photos/{i}.dng")), None)?;
            }
            Ok(())
        }).unwrap();
        let writer = Catalog::open_existing(&source).unwrap();
        let committed = Arc::new(AtomicBool::new(false));
        let observed = committed.clone();
        // Commit through another connection after VACUUM starts scanning the source.
        // A progress hook makes this deterministic, without threads or timing sleeps.
        c.conn.progress_handler(1000, Some(move || {
            if !observed.swap(true, Ordering::SeqCst) {
                writer.batch(|writer| {
                    writer.conn.execute("UPDATE images SET rating=5", [])?;
                    writer.add_image("new", Path::new("/photos/new.dng"), None)?;
                    writer.set_rating("new", 5)?;
                    Ok(())
                }).unwrap();
            }
            false
        }));
        let dest = d.path().join("live.sqlite");
        let result = c.backup_to(&dest, false);
        c.conn.progress_handler(0, None::<fn() -> bool>);
        let report = result.unwrap();
        assert!(committed.load(Ordering::SeqCst));
        assert_eq!(c.counts().unwrap().0, 1001);
        let copy = Catalog::open_existing(&dest).unwrap();
        let integrity: String = copy.conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        assert_eq!(copy.counts().unwrap().0, 1000);
        let changed: i64 = copy.conn.query_row("SELECT count(*) FROM images WHERE rating != 0", [], |r| r.get(0)).unwrap();
        assert_eq!(changed, 0, "no part of the later transaction belongs in the snapshot");
        assert_eq!(report.images, copy.counts().unwrap().0, "report the snapshot, not the live catalog after it changed");
    }

    /// A cancel rides the connection's progress handler into the VACUUM:
    /// the copy is interrupted, the partial file is left where it is and
    /// named in the error, and the source catalog is untouched.
    #[test]
    fn a_cancelled_backup_leaves_the_partial_named_and_the_source_intact() {
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
        let d = tempfile::tempdir_in("/tmp").unwrap();
        let source = d.path().join("catalog.sqlite");
        let c = Catalog::open(&source).unwrap();
        c.batch(|c| {
            for i in 0..2000 {
                c.add_image(&format!("img_{i}"), Path::new(&format!("/photos/{i}.dng")), None)?;
            }
            Ok(())
        }).unwrap();
        let ticks = Arc::new(AtomicU64::new(0));
        let counting = ticks.clone();
        let dest = d.path().join("copy.sqlite");
        // True once, then false: the first probe proves the handler is
        // really firing during the copy, the second cancels it.
        let tick: VacuumTick = Arc::new(move |_| counting.fetch_add(1, Ordering::SeqCst) == 0);
        let err = c.backup_to_watched(&dest, false, Some(tick)).unwrap_err();
        assert!(ticks.load(Ordering::SeqCst) >= 2, "the probe ran during the copy, not only at the end");
        let words = err.to_string();
        assert!(words.contains("canceled"), "{words}");
        let partial = partial_backup_path(&dest);
        assert!(words.contains(&partial.display().to_string()), "the partial is named: {words}");
        assert!(partial.is_file(), "the unfinished copy is left where it is, never deleted");
        assert!(!dest.exists(), "a canceled copy never takes the backup's name");
        assert_eq!(c.counts().unwrap().0, 2000, "the source is untouched");
        assert_eq!(Catalog::open_existing(&source).unwrap().counts().unwrap().0, 2000);
    }

    /// A catalog small enough that the VACUUM finishes inside one
    /// handler interval is still cancelable: the probe runs once more
    /// after verification, before the rename.
    #[test]
    fn a_cancel_after_verify_still_stops_the_backup_before_the_rename() {
        use std::sync::Arc;
        let d = tempfile::tempdir_in("/tmp").unwrap();
        let source = d.path().join("catalog.sqlite");
        let c = Catalog::open(&source).unwrap();
        c.add_image("img_0", Path::new("/photos/0.dng"), None).unwrap();
        let dest = d.path().join("copy.sqlite");
        let tick: VacuumTick = Arc::new(|_| false);
        let err = c.backup_to_watched(&dest, false, Some(tick)).unwrap_err();
        assert!(err.to_string().contains("canceled"), "{err}");
        assert!(partial_backup_path(&dest).is_file(), "left, labeled, for the user to remove");
        assert!(!dest.exists());
        // And an unwatched backup of the same source still works, so the
        // interrupt left the connection usable.
        let second = d.path().join("second.sqlite");
        c.backup_to(&second, false).unwrap();
        assert_eq!(Catalog::open_existing(&second).unwrap().counts().unwrap().0, 1);
    }

    /// Importing must never overwrite what the user already has. Image
    /// ids come from the file path, so the same photograph collides on
    /// purpose, and the local row is the one that survives.
    #[test]
    fn importing_adds_what_is_new_and_keeps_local_ratings() {
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("other.sqlite");
        {
            let other = Catalog::open(&other_path).unwrap();
            let f = other.add_folder(Path::new("D:/photos/shared")).unwrap();
            other.add_image("img_same", Path::new("D:/photos/shared/a.dng"), Some(f)).unwrap();
            other.add_image("img_new", Path::new("D:/photos/shared/b.dng"), Some(f)).unwrap();
            other.set_rating("img_same", 1).unwrap();
            other.set_rating("img_new", 2).unwrap();
            let col = other.create_collection("Imported Set").unwrap();
            other.add_to_collection(col, "img_new").unwrap();
        }

        let c = Catalog::open_in_memory().unwrap();
        let local = c.add_folder(Path::new("D:/photos/shared")).unwrap();
        c.add_image("img_same", Path::new("D:/photos/shared/a.dng"), Some(local)).unwrap();
        c.set_rating("img_same", 5).unwrap();

        let report = c.import_from(&other_path).unwrap();
        assert_eq!(report.images_added, 1);
        assert_eq!(report.images_skipped, 1);
        assert_eq!(report.collections_added, 1);
        // The folder already existed by path, so it was matched, not duplicated.
        assert_eq!(report.folders_added, 0);
        assert_eq!(c.list_folders().unwrap().len(), 1);

        // The local rating stands; the new image arrives with its own.
        assert_eq!(c.image("img_same").unwrap().rating, 5);
        assert_eq!(c.image("img_new").unwrap().rating, 2);
        // And the new image is attached to the LOCAL folder id, not the
        // other catalog's. This is the part that silently corrupts if
        // folder_id is copied straight across.
        assert_eq!(c.image("img_new").unwrap().folder_id, Some(local));
        assert_eq!(
            c.list_images(&Filter { folder_id: Some(local), ..Default::default() }).unwrap().len(),
            2
        );
    }

    /// Phase 6: a watched import reports rows examined and added as it
    /// goes, and a stop between statements aborts the transaction: the
    /// target catalog holds none of the donor's rows, not even the
    /// folders the first statement had already inserted.
    #[test]
    fn a_cancelled_import_rolls_back_and_reports_what_it_saw() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("other.sqlite");
        {
            let other = Catalog::open(&other_path).unwrap();
            let f = other.add_folder(Path::new("D:/photos/donor")).unwrap();
            for i in 0..20 {
                other.add_image(&format!("img_{i}"), Path::new(&format!("D:/photos/donor/{i}.dng")), Some(f)).unwrap();
            }
            let col = other.create_collection("Donor Set").unwrap();
            other.add_to_collection(col, "img_0").unwrap();
        }
        let c = Catalog::open_in_memory().unwrap();

        // Stop after the first step's report: the folders were already
        // inserted by then, and the rollback is the whole point.
        let calls = AtomicU64::new(0);
        let stop_calls = std::sync::Arc::new(AtomicU64::new(0));
        let counting = stop_calls.clone();
        let mut ticks: Vec<(u64, u64, u64)> = Vec::new();
        let err = c
            .import_from_watched(
                &other_path,
                std::sync::Arc::new(move || counting.fetch_add(1, Ordering::SeqCst) > 0),
                &mut |examined, added, total| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    ticks.push((examined, added, total));
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains("canceled"), "{err}");
        assert!(ticks.len() >= 1, "progress ran before the stop");
        assert_eq!(ticks[0].0, 1, "one folder examined in the first step");
        assert_eq!(ticks[0].1, 1, "one folder added in the first step");
        assert_eq!(ticks[0].2, 1 + 20 + 1 + 1, "the total counts the donor's folders, images, collections, members and thumbnails");
        let (images, folders, collections) = c.counts().unwrap();
        assert_eq!((images, folders, collections), (0, 0, 0), "the transaction rolled back: nothing half-landed");
        // The donor is untouched, and a later import of it still works.
        assert_eq!(Catalog::open(&other_path).unwrap().counts().unwrap().0, 20);
        let report = c.import_from(&other_path).unwrap();
        assert_eq!(report.images_added, 20);
    }

    /// A stop asked for while the images insert is running lands inside
    /// that statement through the progress handler, not after it: the
    /// transaction rolls back whole and the answer is still `Cancelled`.
    /// The flag turns true only once the folders step has reported and
    /// the images statement has begun, so a stop between statements
    /// cannot be what answered.
    #[test]
    fn a_stop_inside_the_images_insert_interrupts_it_and_rolls_back() {
        use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("other.sqlite");
        {
            let other = Catalog::open(&other_path).unwrap();
            let f = other.add_folder(Path::new("D:/photos/donor")).unwrap();
            other.batch(|o| {
                for i in 0..6000 {
                    o.add_image(&format!("img_{i}"), Path::new(&format!("D:/photos/donor/{i}.dng")), Some(f))?;
                }
                Ok(())
            }).unwrap();
        }
        let c = Catalog::open_in_memory().unwrap();
        // Armed by the folders step's report; the between-statement
        // check before the images insert is the second poll and is let
        // through, so the interrupt has to come from inside the insert.
        let armed = Arc::new(AtomicBool::new(false));
        let polls_since_armed = Arc::new(AtomicU64::new(0));
        let flag_armed = armed.clone();
        let flag_polls = polls_since_armed.clone();
        let stop: StopFlag = Arc::new(move || {
            if !flag_armed.load(Ordering::SeqCst) {
                return false;
            }
            flag_polls.fetch_add(1, Ordering::SeqCst) >= 2
        });
        let mut reports = 0u64;
        let err = c
            .import_from_watched(&other_path, stop, &mut |_, _, _| {
                reports += 1;
                armed.store(true, Ordering::SeqCst);
            })
            .unwrap_err();
        assert!(matches!(err, CatalogError::Cancelled(_)), "{err}");
        assert_eq!(reports, 1, "only the folders step reported; the images insert never finished");
        assert!(polls_since_armed.load(Ordering::SeqCst) > 2, "the handler polled inside the insert");
        let (images, folders, collections) = c.counts().unwrap();
        assert_eq!((images, folders, collections), (0, 0, 0), "rolled back whole");
        // The connection is still usable and the merge still lands unwatched.
        assert_eq!(c.import_from(&other_path).unwrap().images_added, 6000);
    }

    #[test]
    fn importing_shared_images_unions_keywords_and_remaps_collection_membership() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("donor.sqlite");
        let donor = Catalog::open(&path).unwrap();
        donor.add_image("shared", Path::new("/photos/shared.png"), None).unwrap();
        donor.set_rating("shared", 1).unwrap();
        donor.set_keywords("shared", &["incoming".into(), "local".into()]).unwrap();
        let remote = donor.create_collection("Favorites").unwrap();
        donor.add_to_collection(remote, "shared").unwrap();
        let local = Catalog::open_in_memory().unwrap();
        local.create_collection("Unrelated").unwrap();
        let own = local.create_collection("Favorites").unwrap();
        assert_ne!(remote, own);
        local.add_image("shared", Path::new("/photos/shared.png"), None).unwrap();
        local.set_rating("shared", 5).unwrap();
        local.set_keywords("shared", &["local".into()]).unwrap();
        for _ in 0..2 {
            let report = local.import_from(&path).unwrap();
            assert_eq!(report.images_added, 0);
            assert_eq!(report.images_skipped, 1);
            assert_eq!(report.collections_added, 0);
            assert_eq!(local.image("shared").unwrap().rating, 5);
            assert_eq!(local.keywords_of("shared").unwrap(), vec!["incoming", "local"]);
            let members = local.list_images(&Filter { collection_id: Some(own), ..Default::default() }).unwrap();
            assert_eq!(members.len(), 1);
            assert_eq!(members[0].id, "shared");
        }
    }

    #[test]
    fn a_failed_import_rolls_back_earlier_rows_and_releases_the_source() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("source.sqlite");
        let donor = Catalog::open(&source).unwrap();
        donor.add_folder(Path::new("/incoming")).unwrap();
        donor.add_image("incoming", Path::new("/incoming/a.png"), None).unwrap();
        donor.conn.execute_batch("DROP TABLE keywords").unwrap();
        let local = Catalog::open_in_memory().unwrap();
        assert!(local.import_from(&source).is_err());
        assert_eq!(local.counts().unwrap().0, 0);
        assert!(local.list_folders().unwrap().is_empty());
        donor.conn.execute_batch(MIGRATION_V11).unwrap();
        // The donor is a second connection to a WAL file the import
        // reads through an attach. On exFAT the write-ahead index is
        // not coherent between connections (FSKit), so the reader can
        // miss the table just re-created; folding the log into the
        // file first keeps this test about the rollback, not the
        // drive. The app holds one connection to a live catalog, so it
        // never reads its own catalog through a second one.
        donor.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        assert_eq!(local.import_from(&source).unwrap().images_added, 1);
    }

    /// A hidden image stays hidden through an import rather than
    /// reappearing because it arrived down a different road.
    #[test]
    fn importing_carries_the_hidden_flag() {
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("other.sqlite");
        {
            let other = Catalog::open(&other_path).unwrap();
            other.add_image("img_h", Path::new("D:/photos/h.dng"), None).unwrap();
            other.set_hidden("img_h", true).unwrap();
        }
        let c = Catalog::open_in_memory().unwrap();
        c.import_from(&other_path).unwrap();
        assert!(c.is_hidden("img_h").unwrap());
        assert!(c.list_images(&Filter::default()).unwrap().is_empty());
    }

    #[test]
    fn importing_something_that_is_not_a_catalog_is_refused_whole() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog::open_in_memory().unwrap();
        assert!(matches!(
            c.import_from(&dir.path().join("nothing-here.sqlite")),
            Err(CatalogError::NotACatalog(_))
        ));
        // An empty SQLite file is not a catalog either: user_version 0.
        // Naming it newer than this build would send the user looking
        // for an upgrade that cannot help.
        let blank = dir.path().join("blank.sqlite");
        raw_open(&blank).unwrap().execute_batch("CREATE TABLE x (y)").unwrap();
        assert!(matches!(c.import_from(&blank), Err(CatalogError::NotACatalog(_))));
        // Nothing landed, and the connection still works afterwards: a
        // failed ATTACH that is never detached locks the file for the
        // rest of the session.
        assert_eq!(c.counts().unwrap().0, 0);
        c.add_image("after", Path::new("D:/photos/after.dng"), None).unwrap();
        assert_eq!(c.counts().unwrap().0, 1);
    }

    /// Importing the same catalog twice changes nothing the second time.
    #[test]
    fn importing_twice_is_the_same_as_importing_once() {
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("other.sqlite");
        {
            let other = Catalog::open(&other_path).unwrap();
            let f = other.add_folder(Path::new("D:/photos/x")).unwrap();
            other.add_image("img_a", Path::new("D:/photos/x/a.dng"), Some(f)).unwrap();
            other.create_collection("Set").unwrap();
        }
        let c = Catalog::open_in_memory().unwrap();
        let first = c.import_from(&other_path).unwrap();
        let second = c.import_from(&other_path).unwrap();
        assert_eq!(first.images_added, 1);
        assert_eq!(second.images_added, 0);
        assert_eq!(second.images_skipped, 1);
        assert_eq!(second.folders_added, 0);
        assert_eq!(second.collections_added, 0);
        assert_eq!(c.counts().unwrap(), (1, 1, 1));
    }

    #[test]
    fn collection_summaries_count_members() {
        let c = catalog_with_images();
        let set = c.create_collection("Set").unwrap();
        let empty = c.create_collection("Empty").unwrap();
        c.add_to_collection(set, "img_1").unwrap();
        c.add_to_collection(set, "img_2").unwrap();
        let list = c.collection_summaries().unwrap();
        assert_eq!(list.len(), 2);
        let by_id = |id: i64| list.iter().find(|s| s.id == id).unwrap();
        assert_eq!(by_id(set).image_count, 2);
        assert_eq!(by_id(empty).image_count, 0);
    }

    #[test]
    fn rename_and_delete_collection() {
        let c = catalog_with_images();
        let id = c.create_collection("Draft").unwrap();
        c.add_to_collection(id, "img_1").unwrap();
        c.rename_collection(id, "Final").unwrap();
        assert_eq!(c.collection_summaries().unwrap()[0].name, "Final");

        c.delete_collection(id).unwrap();
        assert!(c.collection_summaries().unwrap().is_empty());
        // Image survives collection deletion.
        assert!(c.image("img_1").is_ok());
        assert!(matches!(c.delete_collection(id), Err(CatalogError::CollectionNotFound(_))));
        assert!(matches!(
            c.rename_collection(id, "x"),
            Err(CatalogError::CollectionNotFound(_))
        ));
    }

    /// The owner's rule: the shortlist is for folders opened deliberately,
    /// not every folder the tree happened to walk through. Browsing a deep
    /// archive used to bury the two folders actually being worked on.
    #[test]
    fn folder_shortlist_holds_picked_folders_only() {
        let c = Catalog::open_in_memory().unwrap();
        for i in 0..7 {
            let f = c.add_folder(Path::new(&format!("D:/photos/f{i}"))).unwrap();
            let id = format!("img_{i}");
            c.add_image(&id, Path::new(&format!("D:/photos/f{i}/a.dng")), Some(f)).unwrap();
            // Everything gets visited; only some get picked.
            c.touch_folder(f).unwrap();
            if i != 3 {
                c.pick_folder(f).unwrap();
            }
        }
        let list = c.recent_picked_folders(5).unwrap();
        assert_eq!(list.len(), 5, "capped at five");
        assert!(
            !list.iter().any(|f| f.path.ends_with("f3")),
            "a folder only ever browsed to stays out"
        );
        assert!(list.iter().all(|f| f.image_count == 1), "counts still come through");
    }

    /// An empty folder the user opened on purpose is still a folder they
    /// opened. Joining through images would have dropped it.
    #[test]
    fn a_picked_folder_with_no_images_still_lists() {
        let c = Catalog::open_in_memory().unwrap();
        let f = c.add_folder(Path::new("D:/photos/empty")).unwrap();
        c.pick_folder(f).unwrap();
        let list = c.recent_picked_folders(5).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].image_count, 0);
    }

    #[test]
    fn meta_round_trips_and_upserts() {
        let c = Catalog::open_in_memory().unwrap();
        assert_eq!(c.meta("tree_root").unwrap(), None);
        c.set_meta("tree_root", "F:/JUNE-2023").unwrap();
        c.set_meta("active_folder", "F:/JUNE-2023/060123").unwrap();
        assert_eq!(c.meta("tree_root").unwrap().as_deref(), Some("F:/JUNE-2023"));
        c.set_meta("tree_root", "F:/JULY-2023").unwrap();
        assert_eq!(c.meta("tree_root").unwrap().as_deref(), Some("F:/JULY-2023"));
    }

    #[test]
    fn edited_folder_paths_reflect_marks_and_clears() {
        let c = Catalog::open_in_memory().unwrap();
        let a = c.add_folder(Path::new("D:/photos/a")).unwrap();
        let b = c.add_folder(Path::new("D:/photos/b")).unwrap();
        c.add_image("img_a", Path::new("D:/photos/a/1.dng"), Some(a)).unwrap();
        c.add_image("img_b", Path::new("D:/photos/b/1.dng"), Some(b)).unwrap();
        assert!(c.edited_folder_paths().unwrap().is_empty());
        c.set_edited("img_a").unwrap();
        assert_eq!(c.edited_folder_paths().unwrap(), vec!["D:/photos/a"]);
        c.clear_edited("img_a").unwrap();
        assert!(c.edited_folder_paths().unwrap().is_empty());
        assert!(matches!(c.set_edited("ghost"), Err(CatalogError::ImageNotFound(_))));
    }

    #[test]
    fn catalog_counts_summarize_everything() {
        let c = catalog_with_images();
        c.add_folder(Path::new("D:/photos")).unwrap();
        c.create_collection("Set").unwrap();
        assert_eq!(c.counts().unwrap(), (3, 1, 1));
    }

    #[test]
    fn v1_catalog_migrates_to_v2() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        // Hand-build a v1 database, as shipped before folder recency.
        {
            let conn = raw_open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute("INSERT INTO folders (path) VALUES ('D:/old')", []).unwrap();
        }
        let c = Catalog::open(&path).unwrap();
        let list = c.folder_summaries().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].last_opened, 0, "migrated folders default to never-opened");
        c.touch_folder(list[0].id).unwrap();
        assert!(c.folder_summaries().unwrap()[0].last_opened > 0);
    }

    /// Upgrading must not invent history. Folders already in the catalog
    /// were recorded when merely browsing to one counted, so none of
    /// them can be claimed as deliberately picked: the shortlist starts
    /// empty and fills as the user opens folders.
    #[test]
    fn v5_catalog_migrates_to_v6_without_backfilling_picks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        {
            let conn = raw_open(&path).unwrap();
            for m in [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 5).unwrap();
            conn.execute("INSERT INTO folders (path) VALUES ('D:/browsed')", []).unwrap();
        }
        let c = Catalog::open(&path).unwrap();
        assert!(c.recent_picked_folders(10).unwrap().is_empty());
        let id = c.add_folder(Path::new("D:/browsed")).unwrap();
        c.pick_folder(id).unwrap();
        assert_eq!(c.recent_picked_folders(10).unwrap().len(), 1);
    }

    #[test]
    fn v3_migration_purges_pre_orientation_thumbnails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.sqlite");
        // v2 database with a cached (unrotated-era) thumbnail.
        {
            let conn = raw_open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
            conn.execute(
                "INSERT INTO images (id, path, file_name, extension, added_at)
                 VALUES ('img_1', 'D:/p/a.rw2', 'a.rw2', 'rw2', 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO thumbnails (image_id, kind, data, updated_at)
                 VALUES ('img_1', 'embedded', x'00', 1)",
                [],
            )
            .unwrap();
        }
        let c = Catalog::open(&path).unwrap();
        assert!(c.thumbnail("img_1").unwrap().is_none(), "stale thumbs purged once");
        // The image itself survives; only the cache resets.
        assert!(c.image("img_1").is_ok());
        c.store_thumbnail("img_1", ThumbKind::Embedded, b"new").unwrap();
        assert!(c.thumbnail("img_1").unwrap().is_some());
    }

    #[test]
    fn image_lookup_by_path() {
        let c = catalog_with_images();
        assert_eq!(
            c.image_id_by_path(Path::new("D:/photos/bbb.jpg")).unwrap(),
            Some("img_2".to_string())
        );
        assert_eq!(c.image_id_by_path(Path::new("D:/photos/zzz.jpg")).unwrap(), None);
    }

    #[test]
    fn dimensions_update() {
        let c = catalog_with_images();
        c.set_dimensions("img_1", 8256, 5504).unwrap();
        let img = c.image("img_1").unwrap();
        assert_eq!(img.width, Some(8256));
        assert_eq!(img.height, Some(5504));
    }

    /// The scan reads hidden ids as one set per folder; this pins the
    /// query the app layer's hidden-skip is built on.
    #[test]
    fn hidden_ids_come_back_as_one_set_per_folder() {
        let c = Catalog::open_in_memory().unwrap();
        let f = c.add_folder(Path::new("D:/photos")).unwrap();
        let g = c.add_folder(Path::new("D:/other")).unwrap();
        c.add_image("a", Path::new("D:/photos/a.dng"), Some(f)).unwrap();
        c.add_image("b", Path::new("D:/photos/b.dng"), Some(f)).unwrap();
        c.add_image("z", Path::new("D:/other/z.dng"), Some(g)).unwrap();
        c.set_hidden("a", true).unwrap();

        assert_eq!(c.hidden_ids_in_folder(f).unwrap(), vec!["a"]);
        assert!(c.hidden_ids_in_folder(g).unwrap().is_empty());
    }

    /// A trashed photograph's file is not in the folder, so it cannot be
    /// in the count either: the shortlist badge and the ribbon it opens
    /// must agree. Hidden photographs still count: they are one Recover
    /// Hidden away from view.
    #[test]
    fn counts_leave_trashed_photographs_out() {
        let c = Catalog::open_in_memory().unwrap();
        let f = c.add_folder(Path::new("D:/photos")).unwrap();
        c.add_image("a", Path::new("D:/photos/a.dng"), Some(f)).unwrap();
        c.add_image("b", Path::new("D:/photos/b.dng"), Some(f)).unwrap();
        c.add_image("h", Path::new("D:/photos/h.dng"), Some(f)).unwrap();
        c.set_trashed("b", true).unwrap();
        c.set_hidden("h", true).unwrap();

        assert_eq!(c.folder_summaries().unwrap()[0].image_count, 2, "hidden counts, trashed does not");
        c.pick_folder(f).unwrap();
        assert_eq!(c.recent_picked_folders(5).unwrap()[0].image_count, 2);

        let col = c.create_collection("Set").unwrap();
        for id in ["a", "b", "h"] {
            c.add_to_collection(col, id).unwrap();
        }
        assert_eq!(c.collection_summaries().unwrap()[0].image_count, 2);
        // Put Back restores the count too, since the membership was
        // never touched.
        c.set_trashed("b", false).unwrap();
        assert_eq!(c.collection_summaries().unwrap()[0].image_count, 3);
    }

    /// A taken name must come back as words the panel can show, not as
    /// SQLite's constraint code.
    #[test]
    fn a_duplicate_collection_name_is_refused_with_words() {
        let c = Catalog::open_in_memory().unwrap();
        let id = c.create_collection("Set").unwrap();
        assert!(matches!(
            c.create_collection("Set"),
            Err(CatalogError::CollectionExists(_))
        ));
        let other = c.create_collection("Other").unwrap();
        assert!(matches!(
            c.rename_collection(other, "Set"),
            Err(CatalogError::CollectionExists(_))
        ));
        // Renaming to a free name still works, and so does keeping its own.
        c.rename_collection(id, "Set").unwrap();
        c.rename_collection(other, "Final").unwrap();
        assert_eq!(c.list_collections().unwrap()[1].name, "Set");
    }

    /// Keywords are user work, not a cache: they make the trip. And the
    /// trash mark comes with its image, or the import would resurrect a
    /// row whose file is sitting in `.trash`.
    #[test]
    fn importing_carries_keywords_and_the_trash_mark() {
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("other.sqlite");
        {
            let other = Catalog::open(&other_path).unwrap();
            other.add_image("img_k", Path::new("D:/photos/k.dng"), None).unwrap();
            other.set_keywords("img_k", &["wedding".into(), "details".into()]).unwrap();
            other.add_image("img_t", Path::new("D:/photos/t.dng"), None).unwrap();
            other.set_trashed("img_t", true).unwrap();
        }
        let c = Catalog::open_in_memory().unwrap();
        c.import_from(&other_path).unwrap();
        assert_eq!(c.keywords_of("img_k").unwrap(), vec!["details", "wedding"]);
        assert!(c.is_trashed("img_t").unwrap());
        // And it stays out of the ordinary listing, the same as a
        // locally trashed photograph.
        assert_eq!(c.list_images(&Filter::default()).unwrap().len(), 1);
    }

    /// The import probe never migrates the source, so a catalog written
    /// before keywords and trash existed must still import: the columns
    /// it does not have default rather than fail.
    #[test]
    fn link_groups_ride_the_image_rows_and_come_off_together_or_alone() {
        let d = tempfile::tempdir().unwrap();
        let c = Catalog::open(&d.path().join("catalog.sqlite")).unwrap();
        for i in 0..3 {
            c.add_image(&format!("img_{i}"), Path::new(&format!("/photos/{i}.dng")), None).unwrap();
        }
        assert!(c.image("img_0").unwrap().link_group.is_none());
        c.set_link_group(&["img_0".into(), "img_1".into(), "ghost".into()], Some("link_a")).unwrap();
        assert_eq!(c.image("img_0").unwrap().link_group.as_deref(), Some("link_a"));
        assert_eq!(c.image("img_1").unwrap().link_group.as_deref(), Some("link_a"));
        assert!(c.image("img_2").unwrap().link_group.is_none());
        let listed = c.list_images(&Filter::default()).unwrap();
        assert_eq!(listed.iter().filter(|r| r.link_group.as_deref() == Some("link_a")).count(), 2);
        // Unlinking one leaves the other where it was.
        c.set_link_group(&["img_0".into()], None).unwrap();
        assert!(c.image("img_0").unwrap().link_group.is_none());
        assert_eq!(c.image("img_1").unwrap().link_group.as_deref(), Some("link_a"));
    }

    #[test]
    fn importing_a_pre_keywords_catalog_still_works() {
        let dir = tempfile::tempdir().unwrap();
        let other_path = dir.path().join("old.sqlite");
        {
            let conn = raw_open(&other_path).unwrap();
            // v10: exif but no keywords, no trashed.
            for m in &MIGRATIONS[..10] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 10).unwrap();
            conn.execute(
                "INSERT INTO images (id, path, file_name, extension, added_at, rating)
                 VALUES ('img_old', 'D:/photos/old.dng', 'old.dng', 'dng', 1, 4)",
                [],
            )
            .unwrap();
        }
        let c = Catalog::open_in_memory().unwrap();
        let report = c.import_from(&other_path).unwrap();
        assert_eq!(report.images_added, 1);
        assert_eq!(c.image("img_old").unwrap().rating, 4);
        assert!(!c.is_trashed("img_old").unwrap());
        assert!(c.keywords_of("img_old").unwrap().is_empty());
    }

    /// A symlink that points at its own ancestor would walk forever if
    /// the walker followed it naively; canonical-path dedup visits each
    /// real directory once.
    #[cfg(unix)]
    #[test]
    fn discovery_survives_a_symlink_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(dir.path().join("a.dng"), b"x").unwrap();
        std::fs::write(sub.join("b.dng"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.path(), sub.join("loop")).unwrap();

        let found = discover_files(dir.path()).unwrap();
        assert_eq!(found.len(), 2, "the cycle must not multiply or hang: {found:?}");
    }
}

#[cfg(test)]
mod performance_fixtures {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore = "offline 5000-row catalog fixture"]
    fn bench_library_5000() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.sqlite");
        let catalog = Catalog::open(&path).unwrap();
        catalog.batch(|cat| {
            for i in 0..5000 {
                let id = format!("synthetic-{i}");
                cat.add_image(&id, Path::new(&format!("/synthetic/Photo-{i:05}.png")), None)?;
                cat.set_rating(&id, (i % 6) as u8)?;
            }
            Ok(())
        }).unwrap();
        drop(catalog);
        let start = Instant::now();
        let catalog = Catalog::open(&path).unwrap();
        let rows = catalog.list_images(&Filter::default()).unwrap();
        let open_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(rows.len(), 5000);
        let start = Instant::now();
        let filtered = catalog.list_images(&Filter { min_rating: Some(4), ..Default::default() }).unwrap();
        let filter_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(filtered.len(), 1666);
        let start = Instant::now();
        let mut names: Vec<_> = rows.iter().map(|r| &r.file_name).collect();
        names.sort_unstable_by(|a,b| b.cmp(a));
        let sort_ms = start.elapsed().as_secs_f64() * 1000.0;
        let mut current = 0;
        let mut high = 0;
        // SQLite reports its own connection page cache, schema and prepared
        // statement bytes. These are not process RSS or row allocations.
        let mut sqlite_bytes = 0;
        unsafe {
            for op in [rusqlite::ffi::SQLITE_DBSTATUS_CACHE_USED, rusqlite::ffi::SQLITE_DBSTATUS_SCHEMA_USED, rusqlite::ffi::SQLITE_DBSTATUS_STMT_USED] {
                assert_eq!(rusqlite::ffi::sqlite3_db_status(catalog.conn.handle(), op, &mut current, &mut high, 0), 0);
                sqlite_bytes += current as usize;
            }
        }
        println!("catalog rows=5000 open_list_ms={open_ms:.3} filter_ms={filter_ms:.3} sort_ms={sort_ms:.3} sqlite_retained_bytes={sqlite_bytes} row_struct_bytes={}", rows.capacity()*std::mem::size_of::<ImageRecord>());
    }

    /// The rows that still sit in the -wal journal are in the pre-update
    /// copy. A writer that has not checkpointed (the app after a crash, or
    /// with a journal SQLite has not folded in yet) is the case the
    /// 2026-09-19 loss looked like from the outside: a copy far smaller
    /// than the catalog. "The original DB is 43.7 MB the backup
    /// is 700 KB. That can't be right."
    #[test]
    fn a_pre_update_snapshot_holds_the_rows_still_in_the_journal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.sqlite");
        let writer = Catalog::open(&path).unwrap();
        writer.conn.execute_batch("PRAGMA wal_autocheckpoint = 0").unwrap();
        let folder = writer.add_folder(Path::new("/shots/day1")).unwrap();
        for i in 0..40 {
            writer.add_image(&format!("img{i}"), Path::new(&format!("/shots/day1/{i}.dng")), Some(folder)).unwrap();
        }
        let wal = journal_path(&path).unwrap();
        assert!(std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0), "the rows live in the journal for this test");
        // The writer stays open, as the live app's connection would not
        // (the gate holds the app's own connection closed), and the
        // snapshot still sees every row.
        let dest = dir.path().join("live.sqlite.before-test.sqlite");
        let report = Catalog::snapshot_unopened(&path, &dest, false).unwrap();
        assert_eq!((report.images, report.folders), (40, 1));
        let copy = Catalog::open_existing(&dest).unwrap();
        assert_eq!(copy.counts().unwrap(), (40, 1, 0));
        assert_eq!(copy.conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        drop(writer);
    }

    /// A clean close folds the journal into the file and leaves no -wal
    /// beside it, so a copy placed over the file by hand later meets no
    /// stale journal. The exit path calls checkpoint() before the drop.
    #[test]
    fn checkpoint_then_close_leaves_no_journal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.sqlite");
        let c = Catalog::open(&path).unwrap();
        c.conn.execute_batch("PRAGMA wal_autocheckpoint = 0").unwrap();
        c.add_folder(Path::new("/x")).unwrap();
        let wal = journal_path(&path).unwrap();
        assert!(std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0));
        c.checkpoint().unwrap();
        assert!(std::fs::metadata(&wal).map_or(true, |m| m.len() == 0), "the journal is empty after the checkpoint");
        drop(c);
        assert!(!wal.exists(), "SQLite removes an empty journal when the last connection closes");
    }

    /// A journal on disk at open time is applied by SQLite before the
    /// first read, and when it does not belong to the file (a copy placed
    /// over the catalog by hand, the live catalog's journal left beside
    /// it) the damage would otherwise surface later as "malformed" mid
    /// session. The open checks the file once when a journal was present
    /// and says what happened.
    #[test]
    fn a_stale_journal_is_caught_at_open_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.sqlite");
        {
            let c = Catalog::open(&path).unwrap();
            let f = c.add_folder(Path::new("/shots")).unwrap();
            for i in 0..200 {
                c.add_image(&format!("img{i}"), Path::new(&format!("/shots/{i}.dng")), Some(f)).unwrap();
            }
        }
        // Leave a journal on disk with frames in it: a writer that never
        // closes, as after a crash or a killed process.
        let leaked = Connection::open(&path).unwrap();
        leaked.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0").unwrap();
        leaked.execute("INSERT INTO folders (path) VALUES ('/late')", []).unwrap();
        let wal = journal_path(&path).unwrap();
        assert!(std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0));
        std::mem::forget(leaked);
        // Damage the file's own pages the way a foreign journal does:
        // page 3 onward overwritten with bytes that are not a b-tree.
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            f.seek(SeekFrom::Start(4096 * 2)).unwrap();
            f.write_all(&[0xA5u8; 4096 * 4]).unwrap();
        }
        let err = Catalog::open(&path).err().expect("refused").to_string();
        assert!(err.contains("damaged") && err.contains("journal"), "{err}");
        assert!(err.contains("Restore Catalog from Copy"), "{err}");
    }

    /// The copy is compared with the source before it wears the backup's
    /// name; the report says what both hold.
    #[test]
    fn a_backup_report_counts_folders_and_photographs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.sqlite");
        let c = Catalog::open(&path).unwrap();
        let f = c.add_folder(Path::new("/a")).unwrap();
        c.add_image("i1", Path::new("/a/1.dng"), Some(f)).unwrap();
        c.add_image("i2", Path::new("/a/2.dng"), Some(f)).unwrap();
        let dest = dir.path().join("copy.sqlite");
        let r = c.backup_to(&dest, false).unwrap();
        assert_eq!((r.images, r.folders), (2, 1));
    }

    /// The real thing: the owner's version-16 catalog with the 4 MB journal a killed process
    /// left beside it (2026-09-19), on a temp copy of the three files, when
    /// HEELER_CATALOG_SAMPLE names the folder holding catalog.sqlite, catalog.sqlite-wal and
    /// catalog.sqlite-shm. Ignored in the normal suite; run with
    /// `HEELER_CATALOG_SAMPLE=<folder> cargo test -p heeler-catalog --lib real_catalog --
    /// --ignored --nocapture`. The samples are never touched.
    #[test]
    #[ignore]
    fn real_catalog_sample_survives_the_update_path() {
        let Ok(sample) = std::env::var("HEELER_CATALOG_SAMPLE") else { return };
        let sample = Path::new(&sample);
        let dir = tempfile::tempdir().unwrap();
        for name in ["catalog.sqlite", "catalog.sqlite-wal", "catalog.sqlite-shm"] {
            if sample.join(name).exists() {
                std::fs::copy(sample.join(name), dir.path().join(name)).unwrap();
            }
        }
        let path = dir.path().join("catalog.sqlite");
        let wal = journal_path(&path).unwrap();
        assert!(wal.exists(), "the sample carries its journal");
        // Before anything: pending, and the counts through the journal.
        let pending = Catalog::pending_upgrade(&path).unwrap();
        assert!(matches!(pending, Some((from, to)) if from < to && to == SCHEMA_VERSION), "{pending:?}");
        let before = counts_unopened(&path).unwrap();
        eprintln!("sample: schema {pending:?}, {} photographs, {} folders, {} collections", before.0, before.1, before.2);
        assert!(before.0 > 0 && before.1 > 0);
        // The pre-update copy: whole, unmigrated, verified.
        let dest = dir.path().join("catalog.sqlite.before-test.sqlite");
        let report = Catalog::snapshot_unopened(&path, &dest, false).unwrap();
        assert_eq!((report.images, report.folders), (before.0, before.1));
        assert_eq!(counts_unopened(&dest).unwrap(), before);
        assert_eq!(Catalog::pending_upgrade(&dest).unwrap(), pending, "the copy keeps the old schema");
        assert!(report.bytes < std::fs::metadata(&path).unwrap().len(), "thumbnails left out: {} bytes", report.bytes);
        eprintln!("snapshot: {} bytes, {} thumbnails dropped", report.bytes, report.thumbnails_dropped);
        // The update itself, with the journal on disk at open (quick_check runs).
        let t = std::time::Instant::now();
        let c = Catalog::open(&path).unwrap();
        eprintln!("open with migration and quick_check: {} ms", t.elapsed().as_millis());
        assert_eq!(c.migration_span(), pending);
        assert_eq!(c.counts().unwrap(), before, "nothing lost in the migration");
        let idx: bool = c.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_images_folder_name')", [], |r| r.get(0)).unwrap();
        assert!(idx);
        // A clean close leaves no journal.
        c.checkpoint().unwrap();
        drop(c);
        assert!(!wal.exists(), "no journal after a clean close");
        assert_eq!(Catalog::pending_upgrade(&path).unwrap(), None);
        assert_eq!(counts_unopened(&path).unwrap(), before);
    }
}
