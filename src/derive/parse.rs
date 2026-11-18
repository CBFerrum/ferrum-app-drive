//! What Drive makes of a stored file, as functions of its bytes alone (design S7, 2.4, "Kinds, makers and
//! confinement"): the words of a PDF or an Office file, a picture at a side, a PDF's first page, the picture an Office
//! file carries of its first page, and an image in a size and format asked for. What cannot be read is refused with a
//! note in words. They are to run in the platform's confined helper process, one call of [`run`] each, once the
//! platform has one (design S7, slice P2); until then only their tests call them.

use super::spec;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, imageops::FilterType};
use serde_json::{Value, json};
use std::io::{Cursor, Read};

/// A file's words, at most this many characters (as live documents' words are kept).
pub(crate) const MAX_CHARS: usize = 200_000;
/// The PDF pages read for words.
const MAX_PAGES: usize = 500;
/// The most pixels a picture is made of.
const MAX_PIXELS: u64 = 40_000_000;
/// An Office file's parts: entries looked at, the most read of one part, and of all of them.
const ZIP_ENTRIES: usize = 2_000;
const PART_BYTES: u64 = 64 << 20;
const ALL_BYTES: u64 = 256 << 20;
/// Fewer letters a page than this: a scan (its words are pictures).
const SCANNED_BELOW: usize = 32;

/// What one call made: its bytes (the words as UTF-8 for the text kinds), their type, and what was learnt.
#[derive(Debug)]
pub(crate) struct Made {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub facts: Value,
}

/// The helper's one entry: `args.op` says what to make of `input` (`pdf_text`, `office_text`, `picture` and
/// `pdf_page` with `side`, `office_picture`, `variant` with `spec` and `focal`).
pub(crate) fn run(input: &[u8], args: &Value) -> Result<Made, String> {
    let side = || args.get("side").and_then(Value::as_u64).filter(|s| (16..=4096).contains(s)).map(|s| s as u32).ok_or("side is 16 to 4096 pixels");
    let text = |(words, facts): (String, Value)| Made { bytes: words.into_bytes(), content_type: "text/plain; charset=utf-8", facts };
    match args.get("op").and_then(Value::as_str) {
        Some("pdf_text") => pdf_text(input).map(text),
        Some("office_text") => office_text(input).map(|w| text((w, json!({})))),
        Some("picture") => picture(input, side()?),
        Some("pdf_page") => pdf_page(input, side()?),
        Some("office_picture") => office_picture(input).ok_or_else(|| "carries no picture of its first page".to_string()),
        Some("variant") => {
            let spec = spec::image(args.get("spec").unwrap_or(&Value::Null))?;
            let focal = args.get("focal").and_then(|f| Some((f.get("x")?.as_f64()?, f.get("y")?.as_f64()?)));
            variant(input, &spec, focal)
        }
        other => Err(format!("{} is not something Drive makes", other.unwrap_or("nothing"))),
    }
}

/// The words of a PDF, page by page (the first 500), and `{pages, chars, scanned}`: a PDF with fewer than 32 letters a
/// page is a scan, whose words only text recognition reads.
pub(crate) fn pdf_text(bytes: &[u8]) -> Result<(String, Value), String> {
    let options = lopdf::LoadOptions { max_decompressed_size: Some(ALL_BYTES as usize), ..Default::default() };
    let doc = lopdf::Document::load_mem_with_options(bytes, options).map_err(|e| unreadable_pdf(&e.to_string()))?;
    if doc.is_encrypted() || doc.was_encrypted() {
        return Err(ENCRYPTED.into());
    }
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    let mut words = String::new();
    for page in pages.iter().take(MAX_PAGES) {
        if let Ok(t) = doc.extract_text_with_limit(&[*page], PART_BYTES as usize) {
            words.push_str(t.trim_end());
            words.push('\n');
        }
        if words.len() > MAX_CHARS * 4 {
            break;
        }
    }
    let words = cut(words.trim_end());
    let letters = words.chars().filter(|c| !c.is_whitespace()).count();
    let scanned = !pages.is_empty() && letters / pages.len() < SCANNED_BELOW;
    Ok((words, json!({"pages": pages.len(), "chars": letters, "scanned": scanned})))
}

const ENCRYPTED: &str = "is encrypted, so what it holds cannot be read";

fn unreadable_pdf(why: &str) -> String {
    let lower = why.to_lowercase();
    if lower.contains("encrypt") || lower.contains("decrypt") || lower.contains("password") { ENCRYPTED.into() } else { "could not be read as a PDF".into() }
}

/// At most [`MAX_CHARS`] characters.
fn cut(s: &str) -> String {
    s.chars().take(MAX_CHARS).collect()
}

/// The words of a Word, Excel or PowerPoint file, or an OpenDocument one: the text of its body, headers, footers and
/// notes, of its shared strings, or of its slides and their notes. An archive that unpacks to more than 256 MB is
/// refused.
pub(crate) fn office_text(bytes: &[u8]) -> Result<String, String> {
    office_text_within(bytes, PART_BYTES, ALL_BYTES)
}

fn office_text_within(bytes: &[u8], part_most: u64, all_most: u64) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "could not be read as an Office file".to_string())?;
    let mut names: Vec<String> = zip.file_names().take(ZIP_ENTRIES).filter_map(|n| n.ok().map(|n| n.into_owned())).collect();
    names.sort_by_key(|n| part_order(n));
    let parts: Vec<String> = names.into_iter().filter(|n| part_order(n).is_some()).collect();
    if parts.is_empty() {
        return Err("is no Word, Excel, PowerPoint or OpenDocument file".into());
    }
    let (mut words, mut read) = (String::new(), 0u64);
    for name in parts {
        let entry = zip.by_name(&name).map_err(|_| "could not be read as an Office file".to_string())?;
        let mut xml = Vec::new();
        entry.take(part_most.min(all_most - read) + 1).read_to_end(&mut xml).map_err(|_| "could not be read as an Office file".to_string())?;
        read += xml.len() as u64;
        if read > all_most {
            return Err(format!("unpacks to more than {} MB, so it is not read", all_most >> 20));
        }
        xml_words(&xml, name == "content.xml", &mut words);
        if words.len() > MAX_CHARS * 4 {
            break;
        }
    }
    Ok(cut(words.trim()))
}

/// Which parts hold words, in the order they are read; none for the rest.
fn part_order(name: &str) -> Option<(u8, u32)> {
    let n = |prefix: &str| name.strip_prefix(prefix).and_then(|r| r.strip_suffix(".xml")).and_then(|r| r.parse::<u32>().ok().or(Some(0)));
    match name {
        "word/document.xml" => Some((0, 0)),
        "xl/sharedStrings.xml" | "content.xml" => Some((0, 0)),
        _ if name.starts_with("word/header") && name.ends_with(".xml") => n("word/header").map(|i| (1, i)),
        _ if name.starts_with("word/footer") && name.ends_with(".xml") => n("word/footer").map(|i| (2, i)),
        "word/footnotes.xml" | "word/endnotes.xml" => Some((3, 0)),
        _ if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") => n("xl/worksheets/sheet").map(|i| (1, i)),
        _ if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") => n("ppt/slides/slide").map(|i| (0, i * 2)),
        _ if name.starts_with("ppt/notesSlides/notesSlide") && name.ends_with(".xml") => n("ppt/notesSlides/notesSlide").map(|i| (0, i * 2 + 1)),
        _ => None,
    }
}

/// The text of `xml`: OOXML's text runs (`w:t`, `a:t`, `t`), or every text of an OpenDocument body (`odf`), a line
/// at each paragraph's end, a space for a tab or a run of spaces.
fn xml_words(xml: &[u8], odf: bool, out: &mut String) {
    use quick_xml::XmlVersion;
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut inside = 0usize;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if odf || e.local_name().as_ref() == "t" => inside += 1,
            Ok(Event::End(e)) => {
                let name = e.local_name();
                if odf || name.as_ref() == "t" {
                    inside = inside.saturating_sub(1);
                }
                if matches!(name.as_ref(), "p" | "h" | "si") && !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            Ok(Event::Empty(e)) if matches!(e.local_name().as_ref(), "tab" | "s") => out.push(' '),
            Ok(Event::Empty(e)) if matches!(e.local_name().as_ref(), "br" | "line-break") => out.push('\n'),
            Ok(Event::Text(t)) if inside > 0 => out.push_str(&t.xml_content(XmlVersion::Implicit1_0)),
            Ok(Event::CData(t)) if inside > 0 => out.push_str(&t.xml_content(XmlVersion::Implicit1_0)),
            Ok(Event::GeneralRef(r)) if inside > 0 => match r.resolve_char_ref() {
                Ok(Some(c)) => out.push(c),
                _ => out.push_str(quick_xml::escape::resolve_predefined_entity(&r).unwrap_or_default()),
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
}

/// A picture at `side` pixels at most on its longest side (never larger than it is), turned as its EXIF says, with its
/// transparency kept (PNG) or as a JPEG; `{width, height}` of the picture as it is shown.
pub(crate) fn picture(bytes: &[u8], side: u32) -> Result<Made, String> {
    let img = decode(bytes)?;
    let (width, height) = (img.width(), img.height());
    let fitted = if width <= side && height <= side { img } else { img.resize(side, side, FilterType::Triangle) };
    let png = fitted.color().has_alpha();
    let bytes = if png { encode(&fitted, "png", None)? } else { encode(&fitted, "jpeg", Some(82))? };
    Ok(Made { bytes, content_type: if png { "image/png" } else { "image/jpeg" }, facts: json!({"width": width, "height": height}) })
}

/// An image decoded within bounds (20,000 pixels a side, 512 MB, 40 megapixels) and turned as its EXIF says.
fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let unread = |e: image::ImageError| format!("could not be read as an image: {e}");
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| format!("could not be read: {e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(512 << 20);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(unread)?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(format!("is {w} by {h} pixels, more than pictures are made of ({} megapixels)", MAX_PIXELS / 1_000_000));
    }
    let orientation = decoder.orientation().map_err(unread)?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(unread)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn encode(img: &DynamicImage, format: &str, quality: Option<u8>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let done = match format {
        "png" => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(Cursor::new(&mut out), ImageFormat::Png),
        // ponytail: WebP is written lossless (the only WebP encoder `image` has); quality applies to JPEG.
        "webp" => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(Cursor::new(&mut out), ImageFormat::WebP),
        _ => DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.unwrap_or(82))),
    };
    done.map(|_| out).map_err(|e| format!("could not be written: {e}"))
}

/// A PDF's first page drawn on white, its longest side `side` pixels, as PNG.
pub(crate) fn pdf_page(bytes: &[u8], side: u32) -> Result<Made, String> {
    use hayro::hayro_syntax::{LoadPdfError, Pdf};
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| match e {
        LoadPdfError::Decryption(_) => ENCRYPTED.to_string(),
        LoadPdfError::Invalid => "could not be read as a PDF".to_string(),
    })?;
    let page = pdf.pages().first().ok_or("has no pages")?;
    let (w, h) = page.render_dimensions();
    if !(w > 0.0 && h > 0.0) {
        return Err("has a first page with no size".into());
    }
    let scale = side as f32 / w.max(h);
    let settings = hayro::PixmapSettings { x_scale: scale, y_scale: scale, bg_color: hayro::vello_cpu::color::palette::css::WHITE };
    let pixmap = hayro::render(page, &hayro::RenderCache::new(), &Default::default(), &hayro::RenderSettings::default(), &settings);
    let bytes = pixmap.into_png().map_err(|e| format!("its first page could not be written: {e}"))?;
    Ok(Made { bytes, content_type: "image/png", facts: json!({"pages": pdf.pages().len()}) })
}

/// The picture of its first page an Office file carries: OpenDocument's `Thumbnails/thumbnail.png`, or OOXML's
/// `docProps/thumbnail` in JPEG or PNG; at most 10 MB of it is read.
pub(crate) fn office_picture(bytes: &[u8]) -> Option<Made> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return None;
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    for (name, content_type) in [
        ("Thumbnails/thumbnail.png", "image/png"),
        ("docProps/thumbnail.jpeg", "image/jpeg"),
        ("docProps/thumbnail.jpg", "image/jpeg"),
        ("docProps/thumbnail.png", "image/png"),
    ] {
        let Ok(entry) = zip.by_name(name) else { continue };
        let mut out = Vec::new();
        entry.take(10 << 20).read_to_end(&mut out).ok()?;
        return (!out.is_empty()).then_some(Made { bytes: out, content_type, facts: json!({}) });
    }
    None
}

/// An image as `spec` (canonical, from [`spec::image`]) asks: cropped first, then fitted (`contain` within the size,
/// never larger; `cover` filling it, the window centred on the focal point, else the middle, inside the picture;
/// `exact` stretched to it), in its format.
pub(crate) fn variant(bytes: &[u8], spec: &Value, focal: Option<(f64, f64)>) -> Result<Made, String> {
    if spec.get("preset").is_some() {
        return Err("a preset is resolved to its sizes before a picture is made".into());
    }
    let mut img = decode(bytes)?;
    if let Some(c) = spec.get("crop") {
        let part = |k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        let (iw, ih) = (f64::from(img.width()), f64::from(img.height()));
        let (x, y) = ((part("x") * iw).floor() as u32, (part("y") * ih).floor() as u32);
        let (w, h) = (((part("w") * iw).round() as u32).max(1), ((part("h") * ih).round() as u32).max(1));
        img = img.crop_imm(x, y, w.min(img.width() - x), h.min(img.height() - y));
    }
    let want = |k: &str| spec.get(k).and_then(Value::as_u64).map(|v| v as u32);
    let (w, h) = (want("width"), want("height"));
    let fitted = match (spec.get("fit").and_then(Value::as_str).unwrap_or("contain"), w, h) {
        ("cover", Some(w), Some(h)) => {
            let scale = (f64::from(w) / f64::from(img.width())).max(f64::from(h) / f64::from(img.height()));
            let (sw, sh) = (((f64::from(img.width()) * scale).round() as u32).max(w), ((f64::from(img.height()) * scale).round() as u32).max(h));
            let scaled = img.resize_exact(sw, sh, FilterType::Triangle);
            let (fx, fy) = focal.unwrap_or((0.5, 0.5));
            let left = ((fx.clamp(0.0, 1.0) * f64::from(sw)) - f64::from(w) / 2.0).clamp(0.0, f64::from(sw - w)).round() as u32;
            let top = ((fy.clamp(0.0, 1.0) * f64::from(sh)) - f64::from(h) / 2.0).clamp(0.0, f64::from(sh - h)).round() as u32;
            scaled.crop_imm(left, top, w, h)
        }
        ("exact", Some(w), Some(h)) => img.resize_exact(w, h, FilterType::Triangle),
        (_, w, h) => {
            let (w, h) = (w.unwrap_or(u32::MAX), h.unwrap_or(u32::MAX));
            if img.width() <= w && img.height() <= h { img } else { img.resize(w.min(img.width()), h.min(img.height()), FilterType::Triangle) }
        }
    };
    let format = spec.get("format").and_then(Value::as_str).unwrap_or("jpeg");
    let quality = spec.get("quality").and_then(Value::as_u64).map(|q| q as u8);
    let bytes = encode(&fitted, format, quality)?;
    let content_type = match format {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    Ok(Made { bytes, content_type, facts: json!({"width": fitted.width(), "height": fitted.height()}) })
}
#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};
    use std::io::Write;

    /// A PDF of these objects (the first is the catalogue), its cross-reference worked out; `trailer` added to its
    /// trailer.
    fn pdf_of(objects: &[String], trailer: &str) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![];
        for (i, o) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for o in offsets {
            out.extend(format!("{o:010} 00000 n \n").bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R {trailer} >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
        out
    }

    fn stream(content: &str) -> String {
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len())
    }

    /// Two pages of words in Helvetica.
    fn worded_pdf() -> Vec<u8> {
        let page = |contents: usize| {
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents {contents} 0 R /Resources << /Font << /F1 7 0 R >> >> >>")
        };
        let words = |w: &str| stream(&format!("BT /F1 12 Tf 20 100 Td ({w}) Tj ET"));
        pdf_of(
            &[
                "<< /Type /Catalog /Pages 2 0 R >>".into(),
                "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>".into(),
                page(4),
                words("The quarterly report says the harbour project is ahead of plan"),
                page(6),
                words("Second page: the budget for the bridge stays within its limits"),
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
            ],
            "",
        )
    }

    /// One page, `w` by `h` points, a red rectangle on it and no words.
    fn red_pdf(w: u32, h: u32) -> Vec<u8> {
        pdf_of(
            &[
                "<< /Type /Catalog /Pages 2 0 R >>".into(),
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
                format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Contents 4 0 R >>"),
                stream(&format!("1 0 0 rg 0 0 {w} {h} re f")),
            ],
            "",
        )
    }

    /// A zip of `files` (name, content), deflated.
    fn zipped(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in files {
            w.start_file(*name, options).unwrap();
            w.write_all(content).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 90])))
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90))
            .unwrap();
        out
    }

    /// `jpeg` with an EXIF block saying how the camera was held (`orientation`).
    fn held(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        let mut tiff = b"MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
        tiff.extend(orientation.to_be_bytes());
        tiff.extend([0, 0, 0, 0, 0, 0]);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut out = jpeg[..2].to_vec();
        out.extend([0xFF, 0xE1]);
        out.extend(((app1.len() + 2) as u16).to_be_bytes());
        out.extend(app1);
        out.extend(&jpeg[2..]);
        out
    }

    fn size(bytes: &[u8]) -> (u32, u32) {
        ImageReader::new(Cursor::new(bytes)).with_guessed_format().unwrap().into_dimensions().unwrap()
    }

    #[test]
    fn pdf_text_reads_words_and_counts_pages() {
        let (words, facts) = pdf_text(&worded_pdf()).unwrap();
        assert!(words.contains("harbour project") && words.contains("bridge stays"), "{words}");
        assert_eq!((facts["pages"].clone(), facts["scanned"].clone()), (json!(2), json!(false)), "{facts}");
        let (words, facts) = pdf_text(&red_pdf(200, 100)).unwrap();
        assert_eq!((words.as_str(), facts["scanned"].clone()), ("", json!(true)), "a page with no words is a scan");
        assert_eq!(pdf_text(b"%PDF-1.4 not really").unwrap_err(), "could not be read as a PDF");
        let made = run(&worded_pdf(), &json!({"op": "pdf_text"})).unwrap();
        assert_eq!((made.content_type, made.facts["pages"].clone()), ("text/plain; charset=utf-8", json!(2)));
    }

    #[test]
    fn encrypted_pdf_is_a_note() {
        let mut objects: Vec<String> = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".into(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>".into(),
            stream("(scrambled)"),
        ];
        let key = "<".to_string() + &"ab".repeat(32) + ">";
        objects.push(format!("<< /Filter /Standard /V 1 /R 2 /O {key} /U {key} /P -4 >>"));
        let locked = pdf_of(&objects, "/Encrypt 5 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]");
        assert_eq!(pdf_text(&locked).unwrap_err(), ENCRYPTED);
        assert_eq!(pdf_page(&locked, 320).unwrap_err(), ENCRYPTED);
    }

    #[test]
    fn office_text_from_docx_xlsx_pptx_odt() {
        let docx = zipped(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", br#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p><w:p><w:r><w:t>Q&amp;A</w:t></w:r><w:r><w:delText>gone</w:delText></w:r></w:p></w:body></w:document>"#),
            ("word/header1.xml", br#"<w:hdr xmlns:w="w"><w:p><w:r><w:t>Header line</w:t></w:r></w:p></w:hdr>"#),
        ]);
        assert_eq!(office_text(&docx).unwrap(), "Hello world\nQ&A\nHeader line");
        let xlsx = zipped(&[
            ("xl/sharedStrings.xml", br#"<sst><si><t>Budget</t></si><si><t>Total</t></si></sst>"#),
            (
                "xl/worksheets/sheet1.xml",
                br#"<worksheet><sheetData><row><c><v>42</v></c><c t="inlineStr"><is><t>Inline</t></is></c></row></sheetData></worksheet>"#,
            ),
        ]);
        assert_eq!(office_text(&xlsx).unwrap(), "Budget\nTotal\nInline");
        let pptx = zipped(&[
            ("ppt/slides/slide2.xml", br#"<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>"#),
            ("ppt/slides/slide1.xml", br#"<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>"#),
            ("ppt/notesSlides/notesSlide1.xml", br#"<p:notes><a:p><a:r><a:t>Say this</a:t></a:r></a:p></p:notes>"#),
        ]);
        assert_eq!(office_text(&pptx).unwrap(), "First slide\nSay this\nSecond slide", "slides in order, each with its notes");
        let odt = zipped(&[
            ("mimetype", b"application/vnd.oasis.opendocument.text"),
            ("content.xml", br#"<office:document-content><office:body><office:text><text:h>Plan</text:h><text:p>Ship it &lt;soon&gt;</text:p></office:text></office:body></office:document-content>"#),
        ]);
        assert_eq!(office_text(&odt).unwrap(), "Plan\nShip it <soon>");
        assert!(office_text(&zipped(&[("other.txt", b"x")])).unwrap_err().contains("no Word"));
        assert!(office_text(b"PK\x03\x04 not really").is_err());
    }

    #[test]
    fn zip_bomb_is_refused() {
        let big = format!(r#"<w:document><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>"#, "a".repeat(64 << 10));
        let docx = zipped(&[("word/document.xml", big.as_bytes())]);
        assert!(docx.len() < 4 << 10, "it packs small");
        let refused = office_text_within(&docx, 1 << 20, 16 << 10).unwrap_err();
        assert!(refused.contains("unpacks to more than"), "{refused}");
        assert_eq!(office_text(&docx).unwrap().len(), 64 << 10, "within the real bounds it reads");
    }

    #[test]
    fn picture_turns_by_exif_and_keeps_alpha() {
        let made = picture(&jpeg(2000, 1000), 320).unwrap();
        assert_eq!((made.content_type, size(&made.bytes), made.facts.clone()), ("image/jpeg", (320, 160), json!({"width": 2000, "height": 1000})));
        // Held on its side (EXIF orientation 6), it is shown turned, and never made larger.
        let made = picture(&held(&jpeg(400, 200), 6), 1600).unwrap();
        assert_eq!((size(&made.bytes), made.facts.clone()), ((200, 400), json!({"width": 200, "height": 400})));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 0]))).write_to(Cursor::new(&mut out), ImageFormat::Png).unwrap();
        let made = picture(&out, 320).unwrap();
        assert!(made.content_type == "image/png" && made.bytes.starts_with(b"\x89PNG"), "transparency kept");
        assert!(picture(b"\x89PNG\r\n\x1a\nnot really", 320).unwrap_err().starts_with("could not be read as an image"));
    }

    #[test]
    fn pdf_first_page_drawn() {
        let made = pdf_page(&red_pdf(200, 100), 1280).unwrap();
        assert_eq!(size(&made.bytes), (1280, 640));
        let drawn = image::load_from_memory(&made.bytes).unwrap().to_rgb8();
        assert_eq!(drawn.get_pixel(640, 320).0, [255, 0, 0], "the page's red, drawn");
        assert_eq!(pdf_page(b"%PDF-1.4 not really", 320).unwrap_err(), "could not be read as a PDF");
    }

    #[test]
    fn office_files_carry_their_first_page() {
        let odt = zipped(&[("mimetype", b"application/vnd.oasis.opendocument.text"), ("Thumbnails/thumbnail.png", b"\x89PNG picture")]);
        assert_eq!(office_picture(&odt).map(|m| (m.bytes, m.content_type)), Some((b"\x89PNG picture".to_vec(), "image/png")));
        let docx = zipped(&[("[Content_Types].xml", b"<Types/>"), ("docProps/thumbnail.jpeg", b"\xff\xd8 picture")]);
        assert_eq!(office_picture(&docx).map(|m| m.content_type), Some("image/jpeg"));
        let without = zipped(&[("word/document.xml", b"<w:document/>"), ("docProps/thumbnail.wmf", b"metafile")]);
        assert!(office_picture(&without).is_none(), "a metafile is not a picture made here");
        assert!(office_picture(b"%PDF-1.7").is_none() && office_picture(b"PK\x03\x04 not really a zip").is_none());
    }

    #[test]
    fn variant_cover_centres_on_the_focal_point() {
        // Red on the left, blue on the right.
        let picture = {
            let mut out = Vec::new();
            DynamicImage::ImageRgb8(RgbImage::from_fn(400, 100, |x, _| if x < 200 { Rgb([255, 0, 0]) } else { Rgb([0, 0, 255]) }))
                .write_to(Cursor::new(&mut out), ImageFormat::Png)
                .unwrap();
            out
        };
        let spec = spec::image(&json!({"width": 64, "height": 64, "fit": "cover", "format": "png"})).unwrap();
        let centre = |focal: Option<(f64, f64)>| {
            let made = variant(&picture, &spec, focal).unwrap();
            assert_eq!(size(&made.bytes), (64, 64));
            image::load_from_memory(&made.bytes).unwrap().to_rgb8().get_pixel(32, 32).0
        };
        assert_eq!(centre(Some((0.9, 0.5))), [0, 0, 255], "towards the right");
        assert_eq!(centre(Some((0.1, 0.5))), [255, 0, 0], "towards the left");
        let contain = spec::image(&json!({"width": 64, "format": "jpeg"})).unwrap();
        assert_eq!(size(&variant(&picture, &contain, None).unwrap().bytes), (64, 16), "within the size, as it is shaped");
        let exact = spec::image(&json!({"width": 64, "height": 64, "fit": "exact", "format": "webp"})).unwrap();
        let made = variant(&picture, &exact, None).unwrap();
        assert_eq!((made.content_type, size(&made.bytes)), ("image/webp", (64, 64)));
        let cropped = spec::image(&json!({"width": 64, "format": "png", "crop": {"x": 0.5, "y": 0.0, "w": 0.5, "h": 1.0}})).unwrap();
        let made = variant(&picture, &cropped, None).unwrap();
        assert_eq!(image::load_from_memory(&made.bytes).unwrap().to_rgb8().get_pixel(10, 5).0, [0, 0, 255], "only the right half");
    }
}
