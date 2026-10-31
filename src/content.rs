//! What a file is, judged from its bytes: the content type (never the uploader's claim), Drive's
//! file type for filters and reports, whether browsers may show it inline, and safe names.

/// Types a browser could execute or render as a page: always served as downloads of unknown type.
const ACTIVE: &[&str] = &["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript", "text/xml", "application/xml"];

/// A document people edit together live (`.fdoc`, see `docs`): its bytes are a Yjs state.
pub const FDOC: &str = "application/vnd.ferrum.doc";

/// Types shown inline (previews); everything else is an attachment.
const INLINE: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif", "application/pdf"];

/// A name's extension, lower-case (`Plan.DOCX` → `docx`); empty when it has none.
pub fn extension(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 10 => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn starts(data: &[u8], magic: &[u8]) -> bool {
    data.len() >= magic.len() && &data[..magic.len()] == magic
}

/// Content type from magic numbers; containers (zip, OLE, text) are refined by the extension,
/// which can only choose among types of the same family.
pub fn sniff(data: &[u8], name: &str) -> &'static str {
    let ext = extension(name);
    // A Yjs state has no signature; the platform checks the bytes before taking them as a document.
    if ext == "fdoc" {
        return FDOC;
    }
    let at = |off: usize, magic: &[u8]| data.len() >= off + magic.len() && &data[off..off + magic.len()] == magic;
    if starts(data, b"\x89PNG\r\n\x1a\n") {
        return "image/png";
    }
    if starts(data, b"\xff\xd8\xff") {
        return "image/jpeg";
    }
    if starts(data, b"GIF87a") || starts(data, b"GIF89a") {
        return "image/gif";
    }
    if starts(data, b"RIFF") && at(8, b"WEBP") {
        return "image/webp";
    }
    if starts(data, b"RIFF") && at(8, b"WAVE") {
        return "audio/wav";
    }
    if starts(data, b"RIFF") && at(8, b"AVI ") {
        return "video/x-msvideo";
    }
    if starts(data, b"%PDF-") {
        return "application/pdf";
    }
    if at(4, b"ftyp") {
        return match data.get(8..12).unwrap_or_default() {
            b"avif" | b"avis" => "image/avif",
            b"heic" | b"heix" | b"mif1" | b"msf1" => "image/heic",
            b"qt  " => "video/quicktime",
            b"M4A " | b"M4B " => "audio/mp4",
            _ => "video/mp4",
        };
    }
    if starts(data, b"\x1a\x45\xdf\xa3") {
        return "video/webm";
    }
    if starts(data, b"OggS") {
        return "audio/ogg";
    }
    if starts(data, b"fLaC") {
        return "audio/flac";
    }
    if starts(data, b"ID3") || starts(data, b"\xff\xfb") || starts(data, b"\xff\xf3") || starts(data, b"\xff\xf2") {
        return "audio/mpeg";
    }
    if starts(data, b"MThd") {
        return "audio/midi";
    }
    if starts(data, b"BM") && data.len() > 14 {
        return "image/bmp";
    }
    if starts(data, b"II*\0") || starts(data, b"MM\0*") {
        return "image/tiff";
    }
    if starts(data, b"\0\0\x01\0") {
        return "image/x-icon";
    }
    if starts(data, b"PK\x03\x04") || starts(data, b"PK\x05\x06") {
        return match ext.as_str() {
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "odt" => "application/vnd.oasis.opendocument.text",
            "ods" => "application/vnd.oasis.opendocument.spreadsheet",
            "odp" => "application/vnd.oasis.opendocument.presentation",
            "epub" => "application/epub+zip",
            _ => "application/zip",
        };
    }
    if starts(data, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        return match ext.as_str() {
            "doc" => "application/msword",
            "xls" => "application/vnd.ms-excel",
            "ppt" => "application/vnd.ms-powerpoint",
            _ => "application/x-ole-storage",
        };
    }
    if starts(data, b"\x1f\x8b") {
        return "application/gzip";
    }
    if starts(data, b"7z\xbc\xaf\x27\x1c") {
        return "application/x-7z-compressed";
    }
    if starts(data, b"Rar!\x1a\x07") {
        return "application/vnd.rar";
    }
    if starts(data, b"BZh") {
        return "application/x-bzip2";
    }
    if starts(data, b"\xfd7zXZ\0") {
        return "application/x-xz";
    }
    if at(257, b"ustar") {
        return "application/x-tar";
    }
    if starts(data, b"{\\rtf") {
        return "application/rtf";
    }
    if starts(data, b"SQLite format 3\0") {
        return "application/vnd.sqlite3";
    }
    if starts(data, b"\0asm") {
        return "application/wasm";
    }
    if is_text(data) {
        return text_type(data, &ext);
    }
    "application/octet-stream"
}

/// UTF-8 (or UTF-16 with a byte-order mark) without NUL bytes in the first 8 KB.
fn is_text(data: &[u8]) -> bool {
    if starts(data, b"\xff\xfe") || starts(data, b"\xfe\xff") {
        return true;
    }
    let sample = &data[..data.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        // A character cut at the end of the sample is still text.
        Err(e) => e.error_len().is_none(),
    }
}

/// Markup is recognised from the first element (after an XML declaration, comments and
/// doctypes); other text by its extension.
fn text_type(data: &[u8], ext: &str) -> &'static str {
    let head = String::from_utf8_lossy(&data[..data.len().min(2048)]).to_ascii_lowercase();
    let mut rest = head.trim_start_matches('\u{feff}').trim_start();
    let mut xml = false;
    loop {
        if rest.starts_with("<?xml") {
            xml = true;
        }
        let skip = if rest.starts_with("<?") {
            rest.find("?>").map(|i| i + 2)
        } else if rest.starts_with("<!--") {
            rest.find("-->").map(|i| i + 3)
        } else if rest.starts_with("<!doctype") && !rest.starts_with("<!doctype html") {
            rest.find('>').map(|i| i + 1)
        } else {
            None
        };
        match skip {
            Some(i) => rest = rest[i..].trim_start(),
            None => break,
        }
    }
    if rest.starts_with("<svg") {
        return "image/svg+xml";
    }
    if ["<!doctype html", "<html", "<head", "<body", "<script", "<iframe"].iter().any(|t| rest.starts_with(t)) {
        return "text/html";
    }
    if xml || ext == "xml" {
        return "application/xml";
    }
    match ext {
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "ics" => "text/calendar",
        "vcf" => "text/vcard",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "html" | "htm" => "text/html",
        _ => "text/plain",
    }
}

/// Drive's coarse file type (filters, reports, icons).
pub fn file_type(ctype: &str) -> &'static str {
    match ctype {
        "application/pdf" => "PDF",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.oasis.opendocument.text"
        | "application/msword"
        | "application/rtf"
        | "application/epub+zip"
        | FDOC => "Document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.oasis.opendocument.spreadsheet"
        | "application/vnd.ms-excel"
        | "text/csv"
        | "text/tab-separated-values" => "Spreadsheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        | "application/vnd.oasis.opendocument.presentation"
        | "application/vnd.ms-powerpoint" => "Presentation",
        "application/zip"
        | "application/gzip"
        | "application/x-7z-compressed"
        | "application/vnd.rar"
        | "application/x-bzip2"
        | "application/x-xz"
        | "application/x-tar" => "Archive",
        t if t.starts_with("image/") => "Image",
        t if t.starts_with("video/") => "Video",
        t if t.starts_with("audio/") => "Audio",
        t if t.starts_with("text/") || ["application/json", "application/yaml", "application/xml"].contains(&t) => "Text",
        _ => "Other",
    }
}

/// Whether a browser may show the file in place (images and PDFs; never active types).
pub fn inline_ok(ctype: &str) -> bool {
    INLINE.contains(&ctype)
}

/// The type a download is labelled with: active types become opaque bytes.
pub fn served_type(ctype: &str) -> &str {
    if ACTIVE.contains(&ctype) { "application/octet-stream" } else { ctype }
}

/// Text that is worth handing to an AI agent as a string.
pub fn is_textual(ctype: &str) -> bool {
    file_type(ctype) == "Text" || ctype == "text/csv" || ctype == "text/tab-separated-values"
}

/// A file or folder name as stored: trimmed, 1–255 characters, no path separators or control
/// characters, not `.` or `..`.
pub fn clean_name(raw: &str) -> Result<String, &'static str> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("a name is required");
    }
    if name.chars().count() > 255 {
        return Err("names have at most 255 characters");
    }
    if name == "." || name == ".." {
        return Err("is not a valid name");
    }
    if name.chars().any(|c| c.is_control() || c == '/' || c == '\\') {
        return Err("names cannot contain /, \\ or control characters");
    }
    Ok(name.to_string())
}

/// `report.pdf` → `report (2).pdf`; folders keep dots: `v1.2` → `v1.2 (2)`.
pub fn numbered(name: &str, n: u32, is_folder: bool) -> String {
    let ext = if is_folder { String::new() } else { extension(name) };
    if ext.is_empty() {
        return format!("{name} ({n})");
    }
    let stem = &name[..name.len() - ext.len() - 1];
    format!("{stem} ({n}).{}", &name[name.len() - ext.len()..])
}

/// The part every numbered variant of `name` starts with (`report` for `report.pdf`).
pub fn stem(name: &str, is_folder: bool) -> &str {
    let ext = if is_folder { String::new() } else { extension(name) };
    if ext.is_empty() { name } else { &name[..name.len() - ext.len() - 1] }
}

/// `Content-Disposition` with an ASCII fallback and the exact UTF-8 name (RFC 6266 / 5987).
pub fn disposition(inline: bool, name: &str) -> String {
    let ascii: String = name.chars().map(|c| if (c.is_ascii_graphic() || c == ' ') && c != '"' && c != '\\' { c } else { '_' }).collect();
    let mut encoded = String::with_capacity(name.len() * 3);
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("{}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}", if inline { "inline" } else { "attachment" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_come_from_bytes_not_names() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n....", "photo.pdf"), "image/png");
        assert_eq!(sniff(b"%PDF-1.7 ...", "invoice.png"), "application/pdf");
        assert_eq!(sniff(b"\xff\xd8\xff\xe0 jfif", "x"), "image/jpeg");
        assert_eq!(sniff(b"PK\x03\x04 rest", "Budget.XLSX"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        assert_eq!(sniff(b"PK\x03\x04 rest", "bundle.bin"), "application/zip");
        assert_eq!(sniff(b"\0\0\0\x18ftypmp42", "clip"), "video/mp4");
        assert_eq!(sniff(b"MZ\x90\0\x03\0\0\0", "setup.pdf"), "application/octet-stream");
        assert_eq!(sniff(b"name,amount\nA,1\n", "data.csv"), "text/csv");
        assert_eq!(sniff(b"# Notes\n", "notes.md"), "text/markdown");
        assert_eq!(sniff("héllo wörld".as_bytes(), "note.txt"), "text/plain");
        // A multi-byte character cut by the sample boundary is still text.
        let mut long = vec![b'a'; 8191];
        long.extend("é".as_bytes());
        assert_eq!(sniff(&long, "big.txt"), "text/plain");
    }

    #[test]
    fn markup_is_recognised_whatever_the_name() {
        assert_eq!(sniff(b"  <!DOCTYPE html><html><script>alert(1)</script>", "cute.png"), "text/html");
        assert_eq!(sniff(b"<?xml version=\"1.0\"?>\n<!-- x -->\n<svg onload=alert(1)>", "logo.txt"), "image/svg+xml");
        assert_eq!(sniff(b"<?xml version=\"1.0\"?><feed/>", "feed"), "application/xml");
        assert_eq!(sniff(b"hello <script>x</script>", "page.html"), "text/html");
        assert_eq!(sniff(b"plain words", "page.html"), "text/html");
        for active in ["text/html", "image/svg+xml", "application/xml", "text/javascript"] {
            assert_eq!(served_type(active), "application/octet-stream");
            assert!(!inline_ok(active));
        }
        assert!(inline_ok("image/png") && inline_ok("application/pdf"));
        assert!(!inline_ok("text/plain") && !inline_ok("application/zip"));
    }

    #[test]
    fn file_types_group_formats() {
        assert_eq!(file_type("application/pdf"), "PDF");
        assert_eq!(file_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "Document");
        assert_eq!(file_type("text/csv"), "Spreadsheet");
        assert_eq!(file_type("image/svg+xml"), "Image");
        assert_eq!(file_type("application/gzip"), "Archive");
        assert_eq!(file_type("text/markdown"), "Text");
        assert_eq!(file_type("application/octet-stream"), "Other");
        assert!(is_textual("text/csv") && is_textual("application/json") && !is_textual("image/png"));
    }

    #[test]
    fn names_are_checked_and_numbered() {
        assert_eq!(clean_name("  Q3 report.pdf "), Ok("Q3 report.pdf".into()));
        assert!(clean_name("   ").is_err());
        assert!(clean_name("a/b").is_err() && clean_name("a\\b").is_err() && clean_name("..").is_err() && clean_name("a\nb").is_err());
        assert!(clean_name(&"x".repeat(256)).is_err());
        assert_eq!(numbered("report.pdf", 2, false), "report (2).pdf");
        assert_eq!(numbered("README", 3, false), "README (3)");
        assert_eq!(numbered(".env", 2, false), ".env (2)");
        assert_eq!(numbered("v1.2", 2, true), "v1.2 (2)");
        assert_eq!(stem("report.pdf", false), "report");
        assert_eq!(stem("v1.2", true), "v1.2");
    }

    #[test]
    fn dispositions_quote_safely() {
        assert_eq!(disposition(false, "a b.pdf"), "attachment; filename=\"a b.pdf\"; filename*=UTF-8''a%20b.pdf");
        let d = disposition(true, "rés\"umé;.png");
        assert!(d.starts_with("inline; filename=\"r_s_um_;.png\""), "{d}");
        assert!(d.ends_with("filename*=UTF-8''r%C3%A9s%22um%C3%A9%3B.png"), "{d}");
    }
}
