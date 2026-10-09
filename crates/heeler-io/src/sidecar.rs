//! What Heeler writes down.
//!
//! "Also, write out custom metadata about the version
//! number and notes that were set during editing."
//!
//! To an XMP sidecar beside the photograph, never into the photograph. A
//! RAW file is the negative: nothing in this application modifies one, and
//! a metadata write is not the place to start. XMP rather than a private
//! format because the standard fields (rating, label, description) are
//! then readable by the catalog editors and metadata readers, which is
//! the whole point of writing them out rather than keeping them in the
//! catalog.
//!
//! Takes go in a namespace of our own, since no other application has the
//! concept. They are written as plain nested elements so that a person
//! reading the file with their eyes can see what they say.
//!
//! One thing this deliberately does not do: overwrite somebody else's
//! sidecar. If an .xmp is already there and Heeler did not write it, it
//! belongs to another application and holds edits this code cannot
//! understand, let alone preserve. Refusing is the only safe answer.

use std::path::{Path, PathBuf};

/// One alternate edit, as it is written out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TakeNote {
    pub id: String,
    pub name: String,
    pub note: String,
    /// 1 to 5 stars from the Takes window; 0 is unrated and writes no
    /// element, so an older reader sees the sidecar it always did.
    pub rating: u8,
}

/// Everything Heeler has to say about a photograph.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sidecar {
    /// 0 to 5, written as xmp:Rating so other applications read it
    pub rating: u8,
    /// "pick" or "reject", written as xmp:Label
    pub flag: String,
    /// which take is the current one
    pub active_take: String,
    pub takes: Vec<TakeNote>,
    /// free-text keywords, written as dc:subject (the standard bag
    /// every cataloger reads), so tags travel with the raws to other
    /// software the way ratings already do
    pub keywords: Vec<String>,
}

/// Written into x:xmptk, and the marker that says this file is ours.
pub const WRITER: &str = "Heeler";

const HEELER_NS: &str = "http://heeler.photo/ns/1.0/";

/// Where a photograph's sidecar lives.
///
/// `DSC_0001.arw` gets `DSC_0001.xmp`, replacing the extension rather than
/// appending to it, which is the convention every other application
/// follows and therefore the one that lets them find each other's files.
pub fn sidecar_path(image: &Path) -> PathBuf {
    image.with_extension("xmp")
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        // Ampersand last, or "&amp;lt;" comes back as "<".
        .replace("&amp;", "&")
}

/// The label other applications expect for a flag.
fn label_for(flag: &str) -> &str {
    match flag {
        "pick" => "Pick",
        "reject" => "Reject",
        _ => "",
    }
}

fn flag_from_label(label: &str) -> String {
    match label.to_ascii_lowercase().as_str() {
        "pick" => "pick".into(),
        "reject" => "reject".into(),
        _ => String::new(),
    }
}

/// Renders a sidecar as XMP.
pub fn to_xmp(s: &Sidecar) -> String {
    let mut takes = String::new();
    for t in &s.takes {
        let rating = if t.rating > 0 {
            format!("\n      <heeler:rating>{}</heeler:rating>", t.rating.min(5))
        } else {
            String::new()
        };
        takes.push_str(&format!(
            "\n     <rdf:li rdf:parseType=\"Resource\">\
             \n      <heeler:id>{}</heeler:id>\
             \n      <heeler:name>{}</heeler:name>\
             \n      <heeler:note>{}</heeler:note>{rating}\
             \n     </rdf:li>",
            escape(&t.id),
            escape(&t.name),
            escape(&t.note),
        ));
    }
    let takes_block = if s.takes.is_empty() {
        String::new()
    } else {
        format!(
            "\n    <heeler:Takes>\n     <rdf:Seq>{takes}\n     </rdf:Seq>\n    </heeler:Takes>",
        )
    };
    // dc:subject, the interop bag: the catalog editors, file browsers and
    // every DAM read keywords from exactly here.
    let keywords_block = if s.keywords.is_empty() {
        String::new()
    } else {
        let items: String = s
            .keywords
            .iter()
            .map(|k| format!("\n      <rdf:li>{}</rdf:li>", escape(k)))
            .collect();
        format!(
            "\n    <dc:subject>\n     <rdf:Bag>{items}\n     </rdf:Bag>\n    </dc:subject>",
        )
    };
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
         <x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"{WRITER}\">\n\
         \x20<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
         \x20 <rdf:Description rdf:about=\"\"\n\
         \x20   xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
         \x20   xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n\
         \x20   xmlns:heeler=\"{HEELER_NS}\"\n\
         \x20   xmp:Rating=\"{rating}\"\n\
         \x20   xmp:Label=\"{label}\"\n\
         \x20   heeler:ActiveTake=\"{take}\">{keywords_block}{takes_block}\n\
         \x20 </rdf:Description>\n\
         \x20</rdf:RDF>\n\
         </x:xmpmeta>\n\
         <?xpacket end=\"w\"?>\n",
        rating = s.rating.min(5),
        label = escape(label_for(&s.flag)),
        take = escape(&s.active_take),
    )
}

/// The value of an attribute, anywhere in the document.
fn attr(xml: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let at = xml.find(&key)? + key.len();
    let end = xml[at..].find('"')? + at;
    Some(unescape(&xml[at..end]))
}

/// The text of the first `<name>` element after `from`.
fn element(xml: &str, name: &str, from: usize) -> Option<(String, usize)> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = xml[from..].find(&open)? + from + open.len();
    let end = xml[start..].find(&close)? + start;
    Some((unescape(&xml[start..end]), end + close.len()))
}

/// Reads back what `to_xmp` wrote.
///
/// Deliberately forgiving: a field that is missing is simply absent, and
/// anything else in the document is ignored rather than treated as an
/// error. The one thing it will not do is claim a file it does not
/// recognize, which is what `written_by_heeler` is for.
pub fn from_xmp(xml: &str) -> Sidecar {
    let mut out = Sidecar {
        rating: attr(xml, "xmp:Rating").and_then(|v| v.parse().ok()).unwrap_or(0).min(5),
        flag: attr(xml, "xmp:Label").map(|v| flag_from_label(&v)).unwrap_or_default(),
        active_take: attr(xml, "heeler:ActiveTake").unwrap_or_default(),
        takes: Vec::new(),
        keywords: Vec::new(),
    };
    // dc:subject's bag: other tools write the same element, so tags
    // they added come in alongside ours.
    if let Some((bag, _)) = element(xml, "dc:subject", 0) {
        let mut kat = 0usize;
        while let Some((kw, next)) = element(&bag, "rdf:li", kat) {
            if !kw.trim().is_empty() {
                out.keywords.push(kw.trim().to_string());
            }
            kat = next;
            if out.keywords.len() > 512 {
                break;
            }
        }
    }
    let mut at = 0usize;
    while let Some((id, next)) = element(xml, "heeler:id", at) {
        let (name, after_name) = element(xml, "heeler:name", next).unwrap_or_default();
        let (note, after_note) = element(xml, "heeler:note", after_name).unwrap_or_default();
        // The rating is optional and belongs to THIS take: looked for
        // only up to the next take's id, or an unrated take would take
        // the stars of the next rated one.
        let seg_end = xml[after_note.min(xml.len())..]
            .find("<heeler:id>")
            .map(|i| after_note + i)
            .unwrap_or(xml.len());
        let rating = element(&xml[..seg_end], "heeler:rating", after_note)
            .and_then(|(v, _)| v.trim().parse::<u8>().ok())
            .unwrap_or(0)
            .min(5);
        out.takes.push(TakeNote { id, name, note, rating });
        at = after_note.max(next);
        if out.takes.len() > 256 {
            break;
        }
    }
    out
}

/// Whether this XMP is one of ours.
///
/// Another application's sidecar holds its edits, and this code can
/// neither read nor preserve them. Anything not written here is left
/// alone.
pub fn written_by_heeler(xml: &str) -> bool {
    attr(xml, "x:xmptk").map(|v| v.contains(WRITER)).unwrap_or(false)
}

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0} was written by another application; Heeler will not overwrite it")]
    NotOurs(PathBuf),
}

/// Writes the sidecar beside the photograph.
///
/// Refuses rather than clobbering a sidecar somebody else wrote. The
/// photograph itself is never opened, let alone written to.
pub fn write_sidecar(image: &Path, s: &Sidecar) -> Result<PathBuf, SidecarError> {
    let path = sidecar_path(image);
    if path.exists() {
        let existing = std::fs::read_to_string(&path)?;
        if !written_by_heeler(&existing) {
            return Err(SidecarError::NotOurs(path));
        }
    }
    std::fs::write(&path, to_xmp(s))?;
    Ok(path)
}

/// Reads the sidecar beside a photograph, if there is one of ours.
pub fn read_sidecar(image: &Path) -> Option<Sidecar> {
    let xml = std::fs::read_to_string(sidecar_path(image)).ok()?;
    // Another application's ratings are still worth reading: those fields
    // are standard and mean the same thing wherever they came from. Only
    // WRITING is restricted.
    Some(from_xmp(&xml))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> Sidecar {
        Sidecar {
            rating: 4,
            flag: "pick".into(),
            active_take: "take_2".into(),
            takes: vec![
                TakeNote { id: "take_1".into(), name: "Base".into(), note: String::new(), rating: 0 },
                TakeNote {
                    id: "take_2".into(),
                    name: "Warmer".into(),
                    note: "pushed the whites & pulled the shadows".into(),
                    rating: 4,
                },
            ],
            keywords: vec!["wedding".into(), "smith & jones".into()],
        }
    }

    #[test]
    fn a_take_s_stars_ride_in_the_sidecar_and_an_unrated_take_writes_none() {
        let xml = to_xmp(&full());
        assert!(xml.contains("<heeler:rating>4</heeler:rating>"));
        assert_eq!(xml.matches("<heeler:rating>").count(), 1, "the unrated take writes no element");
        let back = from_xmp(&xml);
        assert_eq!(back.takes[0].rating, 0);
        assert_eq!(back.takes[1].rating, 4);
        // The stars belong to their own take: an unrated one ahead of a
        // rated one does not borrow its stars.
        let mut swapped = full();
        swapped.takes.swap(0, 1);
        let back = from_xmp(&to_xmp(&swapped));
        assert_eq!((back.takes[0].rating, back.takes[1].rating), (4, 0));
    }

    #[test]
    fn keywords_ride_as_dc_subject_and_read_back() {
        let xml = to_xmp(&full());
        // The standard bag, where every other cataloger looks.
        assert!(xml.contains("<dc:subject>"));
        assert!(xml.contains("<rdf:li>wedding</rdf:li>"));
        let back = from_xmp(&xml);
        assert_eq!(back.keywords, vec!["wedding", "smith & jones"]);
        // No keywords, no element: an empty bag is noise.
        let bare = to_xmp(&Sidecar::default());
        assert!(!bare.contains("dc:subject"));
    }

    #[test]
    fn a_sidecar_reads_back_as_what_was_written() {
        let back = from_xmp(&to_xmp(&full()));
        assert_eq!(back, full());
    }

    #[test]
    fn the_standard_fields_are_where_other_apps_look() {
        // The whole reason for XMP rather than a private format: a rating
        // set here shows up in the file browsers, catalog editors and
        // metadata readers.
        let xml = to_xmp(&full());
        assert!(xml.contains("xmp:Rating=\"4\""));
        assert!(xml.contains("xmp:Label=\"Pick\""));
        assert!(xml.contains("http://ns.adobe.com/xap/1.0/"));
        // And it is a well-formed packet, not a fragment.
        assert!(xml.starts_with("<?xpacket begin="));
        assert!(xml.trim_end().ends_with("<?xpacket end=\"w\"?>"));
        assert_eq!(xml.matches("<rdf:Description").count(), 1);
    }

    #[test]
    fn a_note_with_markup_in_it_survives() {
        // People write "<3" and "R&D" in notes, and an unescaped one
        // would produce a file nothing can parse, including us.
        let s = Sidecar {
            takes: vec![TakeNote {
                id: "t".into(),
                name: "a & b".into(),
                note: "<not a tag> \"quoted\" & more".into(),
                rating: 0,
            }],
            ..Sidecar::default()
        };
        let xml = to_xmp(&s);
        assert!(!xml.contains("<not a tag>"));
        assert_eq!(from_xmp(&xml).takes[0].note, "<not a tag> \"quoted\" & more");
        assert_eq!(from_xmp(&xml).takes[0].name, "a & b");
    }

    #[test]
    fn an_empty_record_writes_an_empty_record() {
        let xml = to_xmp(&Sidecar::default());
        assert!(!xml.contains("heeler:Takes"), "no takes means no list, not an empty one");
        assert_eq!(from_xmp(&xml), Sidecar::default());
    }

    #[test]
    fn a_rating_past_five_is_clamped_rather_than_written() {
        let xml = to_xmp(&Sidecar { rating: 99, ..Sidecar::default() });
        assert!(xml.contains("xmp:Rating=\"5\""));
    }

    #[test]
    fn the_sidecar_sits_beside_the_photograph_and_replaces_the_extension() {
        // The convention every other application follows, which is what
        // lets them find each other's files.
        assert_eq!(sidecar_path(Path::new("D:/shoot/DSC_0001.arw")).file_name().unwrap(), "DSC_0001.xmp");
        assert_eq!(sidecar_path(Path::new("D:/shoot/DSC_0001.arw")).parent(), Path::new("D:/shoot/DSC_0001.arw").parent());
    }

    #[test]
    fn another_applications_sidecar_is_left_exactly_where_it_is() {
        // It holds edits this code can neither read nor preserve.
        // Refusing is the only safe answer.
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("DSC_0001.arw");
        std::fs::write(&image, b"not really a raw").unwrap();
        let theirs = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Adobe XMP Core 5.6\">\
                      <rdf:Description xmp:Rating=\"3\"/></x:xmpmeta>";
        std::fs::write(sidecar_path(&image), theirs).unwrap();

        let err = write_sidecar(&image, &full()).unwrap_err();
        assert!(matches!(err, SidecarError::NotOurs(_)));
        assert_eq!(std::fs::read_to_string(sidecar_path(&image)).unwrap(), theirs);
        // But their standard fields are still worth reading.
        assert_eq!(read_sidecar(&image).unwrap().rating, 3);
    }

    #[test]
    fn our_own_sidecar_is_rewritten_freely() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("DSC_0002.arw");
        std::fs::write(&image, b"raw").unwrap();

        write_sidecar(&image, &full()).unwrap();
        assert!(written_by_heeler(&std::fs::read_to_string(sidecar_path(&image)).unwrap()));
        let mut edited = full();
        edited.rating = 2;
        write_sidecar(&image, &edited).unwrap();
        assert_eq!(read_sidecar(&image).unwrap().rating, 2);

        // And the photograph itself is never touched. It is the negative.
        assert_eq!(std::fs::read(&image).unwrap(), b"raw");
    }

    #[test]
    fn no_sidecar_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_sidecar(&dir.path().join("nothing.arw")).is_none());
    }
}
