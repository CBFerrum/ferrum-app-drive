//! Templates for Office files (Ferrum platform.md, Office): what a new document, spreadsheet or
//! presentation starts from. Some come with Drive, built here in the formats the editors open
//! (documents from Markdown by the platform's Word writer, spreadsheets by rust_xlsxwriter,
//! presentations below). A workspace adds its own: a Drive administrator saves an Office file as
//! one (`DriveTemplate`), and the template keeps a copy of the bytes, so later edits to the file
//! change nothing and nobody needs access to the file to use the template. Everything here is an
//! action on the caller's Drive Space (`list_templates`, `create_from_template`,
//! `save_as_template`, `delete_template`); the Site's `new` takes a `template` too.

use crate::acl::{self, Grants, Level};
use crate::content;
use crate::files::{self, Content, OnConflict};
use crate::ops::{Out, Params};
use crate::tree::{self, Kind, Space};
use ferrum_domain::util::elevated;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx, coedit};
use rust_xlsxwriter::{Color, DataValidation, Format, FormatBorder, Workbook, XlsxError};
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::io::Write as _;
use uuid::Uuid;

/// Office kinds a template may be.
pub const KINDS: [&str; 6] = ["docx", "xlsx", "pptx", "odt", "ods", "odp"];
/// The largest file saved as a template.
const MAX_TEMPLATE: usize = 25 << 20;

pub struct Builtin {
    pub id: &'static str,
    pub kind: &'static str,
    pub title: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    make: fn() -> Result<Vec<u8>>,
}

pub const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "meeting-notes",
        kind: "docx",
        title: "Meeting notes",
        category: "Meetings",
        description: "Agenda, notes, decisions and action items",
        make: || doc("Meeting notes", MEETING_NOTES),
    },
    Builtin {
        id: "project-brief",
        kind: "docx",
        title: "Project brief",
        category: "Projects",
        description: "Summary, goals, scope, milestones and risks",
        make: || doc("Project brief", PROJECT_BRIEF),
    },
    Builtin {
        id: "report",
        kind: "docx",
        title: "Report",
        category: "Reports",
        description: "Summary, background, findings and recommendations",
        make: || doc("Report", REPORT),
    },
    Builtin { id: "letter", kind: "docx", title: "Letter", category: "General", description: "A business letter", make: || doc("Letter", LETTER) },
    Builtin { id: "budget", kind: "xlsx", title: "Budget", category: "Finance", description: "Planned against actual by category, with totals", make: budget },
    Builtin {
        id: "expense-report",
        kind: "xlsx",
        title: "Expense report",
        category: "Finance",
        description: "Dated expenses by category, with receipts and a total",
        make: expenses,
    },
    Builtin {
        id: "task-tracker",
        kind: "xlsx",
        title: "Task tracker",
        category: "Projects",
        description: "Tasks with owners, status, priority and due dates",
        make: tasks,
    },
    Builtin {
        id: "project-update",
        kind: "pptx",
        title: "Project update",
        category: "Projects",
        description: "Where it stands, what is next, risks and asks",
        make: project_update,
    },
    Builtin {
        id: "team-meeting",
        kind: "pptx",
        title: "Team meeting",
        category: "Meetings",
        description: "Agenda, updates, decisions and next steps",
        make: team_meeting,
    },
];

const MEETING_NOTES: &str = "# Meeting notes\n\n**Date:** \n\n**Attendees:** \n\n## Agenda\n\n1. \n2. \n3. \n\n## Notes\n\n\n\n## Decisions\n\n- \n\n## Action items\n\n- [ ] Who · what · by when\n- [ ] \n";
const PROJECT_BRIEF: &str = "# Project brief\n\n## Summary\n\nWhat the project is, in two sentences.\n\n## Goals\n\n- \n- \n\n## Scope\n\n### In scope\n\n- \n\n### Out of scope\n\n- \n\n## Milestones\n\n| Milestone | Date | Owner |\n|---|---|---|\n| Kick-off | | |\n| First release | | |\n| Review | | |\n\n## Risks\n\n- \n";
const REPORT: &str = "# Report\n\n## Summary\n\nThe findings and what they mean, in a paragraph.\n\n## Background\n\n\n\n## Findings\n\n1. \n2. \n3. \n\n## Recommendations\n\n- \n\n## Appendix\n\n";
const LETTER: &str =
    "[Your name]\n\n[Your address]\n\n[Date]\n\n[Recipient's name]\n\n[Their address]\n\nDear [name],\n\n[Your letter.]\n\nYours sincerely,\n\n[Your name]\n";

fn doc(title: &str, md: &str) -> Result<Vec<u8>> {
    coedit::docx(&coedit::from_markdown(md), title, &|_| None)
}

fn xlsx(e: XlsxError) -> Error {
    Error::internal(format!("building a spreadsheet: {e}"))
}

/// A sheet's header row: bold on a light fill, with the columns' widths; the row stays in view.
fn header(sheet: &mut rust_xlsxwriter::Worksheet, columns: &[(&str, f64)]) -> std::result::Result<(), XlsxError> {
    let head = Format::new().set_bold().set_background_color(Color::RGB(0xE8EEF7)).set_border_bottom(FormatBorder::Thin);
    for (col, (name, width)) in columns.iter().enumerate() {
        sheet.write_string_with_format(0, col as u16, *name, &head)?;
        sheet.set_column_width(col as u16, *width)?;
    }
    sheet.set_freeze_panes(1, 0)?;
    // Printed across, one page wide.
    sheet.set_landscape().set_print_fit_to_pages(1, 0);
    Ok(())
}

fn budget() -> Result<Vec<u8>> {
    let mut book = Workbook::new();
    let money = Format::new().set_num_format("#,##0.00");
    let total = Format::new().set_bold().set_num_format("#,##0.00").set_border_top(FormatBorder::Thin);
    let sheet = book.add_worksheet();
    sheet.set_name("Budget").map_err(xlsx)?;
    header(sheet, &[("Category", 24.0), ("Planned", 14.0), ("Actual", 14.0), ("Difference", 14.0), ("Notes", 40.0)]).map_err(xlsx)?;
    let rows = ["Rent", "Salaries", "Software", "Travel", "Marketing", "Equipment", "Other"];
    for (i, name) in rows.iter().enumerate() {
        let r = i as u32 + 1;
        sheet.write_string(r, 0, *name).map_err(xlsx)?;
        sheet.write_number_with_format(r, 1, 0, &money).map_err(xlsx)?;
        sheet.write_number_with_format(r, 2, 0, &money).map_err(xlsx)?;
        sheet.write_formula_with_format(r, 3, format!("=C{0}-B{0}", r + 1).as_str(), &money).map_err(xlsx)?;
    }
    let t = rows.len() as u32 + 1;
    sheet.write_string_with_format(t, 0, "Total", &Format::new().set_bold().set_border_top(FormatBorder::Thin)).map_err(xlsx)?;
    for (col, letter) in [(1u16, 'B'), (2, 'C'), (3, 'D')] {
        sheet.write_formula_with_format(t, col, format!("=SUM({letter}2:{letter}{t})").as_str(), &total).map_err(xlsx)?;
    }
    book.save_to_buffer().map_err(xlsx)
}

fn expenses() -> Result<Vec<u8>> {
    let mut book = Workbook::new();
    let money = Format::new().set_num_format("#,##0.00");
    let date = Format::new().set_num_format("yyyy-mm-dd");
    let sheet = book.add_worksheet();
    sheet.set_name("Expenses").map_err(xlsx)?;
    header(sheet, &[("Date", 14.0), ("Description", 36.0), ("Category", 16.0), ("Amount", 14.0), ("Receipt", 10.0)]).map_err(xlsx)?;
    const ROWS: u32 = 30;
    for r in 1..=ROWS {
        sheet.write_blank(r, 0, &date).map_err(xlsx)?;
        sheet.write_blank(r, 3, &money).map_err(xlsx)?;
    }
    let category = DataValidation::new().allow_list_strings(&["Travel", "Meals", "Lodging", "Supplies", "Software", "Other"]).map_err(xlsx)?;
    sheet.add_data_validation(1, 2, ROWS, 2, &category).map_err(xlsx)?;
    let receipt = DataValidation::new().allow_list_strings(&["Yes", "No"]).map_err(xlsx)?;
    sheet.add_data_validation(1, 4, ROWS, 4, &receipt).map_err(xlsx)?;
    let t = ROWS + 1;
    sheet.write_string_with_format(t, 2, "Total", &Format::new().set_bold()).map_err(xlsx)?;
    sheet.write_formula_with_format(t, 3, format!("=SUM(D2:D{t})").as_str(), &Format::new().set_bold().set_num_format("#,##0.00")).map_err(xlsx)?;
    book.save_to_buffer().map_err(xlsx)
}

fn tasks() -> Result<Vec<u8>> {
    let mut book = Workbook::new();
    let date = Format::new().set_num_format("yyyy-mm-dd");
    let sheet = book.add_worksheet();
    sheet.set_name("Tasks").map_err(xlsx)?;
    header(sheet, &[("Task", 36.0), ("Owner", 18.0), ("Status", 14.0), ("Priority", 12.0), ("Due", 14.0), ("Notes", 40.0)]).map_err(xlsx)?;
    const ROWS: u32 = 50;
    for r in 1..=ROWS {
        sheet.write_blank(r, 4, &date).map_err(xlsx)?;
    }
    let status = DataValidation::new().allow_list_strings(&["Not started", "In progress", "Blocked", "Done"]).map_err(xlsx)?;
    sheet.add_data_validation(1, 2, ROWS, 2, &status).map_err(xlsx)?;
    let priority = DataValidation::new().allow_list_strings(&["Low", "Medium", "High"]).map_err(xlsx)?;
    sheet.add_data_validation(1, 3, ROWS, 3, &priority).map_err(xlsx)?;
    book.save_to_buffer().map_err(xlsx)
}

/// A slide: a title and its points (the first slide is the title slide; its points are the subtitle).
struct Slide<'a> {
    title: &'a str,
    points: &'a [&'a str],
}

fn project_update() -> Result<Vec<u8>> {
    pptx(
        "Project update",
        &[
            Slide { title: "Project update", points: &["Team · Date"] },
            Slide { title: "Where we are", points: &["What shipped since the last update", "What is in progress", "How we track against the plan"] },
            Slide { title: "What is next", points: &["The next milestone and its date", "Who is working on what"] },
            Slide { title: "Risks and asks", points: &["What could slow us down", "What we need, and from whom"] },
        ],
    )
}

fn team_meeting() -> Result<Vec<u8>> {
    pptx(
        "Team meeting",
        &[
            Slide { title: "Team meeting", points: &["Date"] },
            Slide { title: "Agenda", points: &["Updates", "Decisions to make", "Next steps"] },
            Slide { title: "Updates", points: &["Each team, in a sentence or two"] },
            Slide { title: "Decisions", points: &["What we decided, and why"] },
            Slide { title: "Next steps", points: &["Who · what · by when"] },
        ],
    )
}

fn xml(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const GROUP: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

/// A placeholder shape: `ph` its kind (`type="title"`, `idx="1"`…), at `(x, y, w, h)` EMU when given.
fn placeholder(id: u32, name: &str, ph: &str, at: Option<(u64, u64, u64, u64)>, paragraphs: &str) -> String {
    let xfrm = at.map(|(x, y, w, h)| format!("<a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm>")).unwrap_or_default();
    // The title slide's words are centred, and its subtitle is not a list.
    let lst = match ph.split('"').nth(1) {
        Some("ctrTitle") => "<a:lstStyle><a:lvl1pPr algn=\"ctr\"/></a:lstStyle>",
        Some("subTitle") => "<a:lstStyle><a:lvl1pPr marL=\"0\" indent=\"0\" algn=\"ctr\"><a:buNone/></a:lvl1pPr></a:lstStyle>",
        _ => "<a:lstStyle/>",
    };
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph {ph}/></p:nvPr></p:nvSpPr>\
         <p:spPr>{xfrm}</p:spPr><p:txBody><a:bodyPr/>{lst}{paragraphs}</p:txBody></p:sp>"
    )
}

fn paragraphs(lines: &[&str]) -> String {
    if lines.is_empty() {
        return "<a:p><a:endParaRPr lang=\"en-US\"/></a:p>".into();
    }
    lines.iter().map(|l| format!("<a:p><a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>", xml(l))).collect()
}

/// A 16:9 presentation of `slides` with a plain theme: Office Open XML as PowerPoint, Collabora and
/// LibreOffice open it.
fn pptx(title: &str, slides: &[Slide<'_>]) -> Result<Vec<u8>> {
    const W: u64 = 12_192_000;
    const H: u64 = 6_858_000;
    let title_box = Some((838_200, 365_125, W - 2 * 838_200, 1_325_563));
    let body_box = Some((838_200, 1_825_625, W - 2 * 838_200, 4_351_338));
    let mut parts: Vec<(String, String)> = Vec::new();
    let mut types = String::from(
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>\
         <Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>\
         <Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
         <Override PartName=\"/ppt/slideLayouts/slideLayout2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
         <Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>\
         <Override PartName=\"/ppt/presProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presProps+xml\"/>\
         <Override PartName=\"/ppt/viewProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml\"/>\
         <Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/>\
         <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
         <Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>",
    );
    let mut ids = String::new();
    let mut rels = String::from(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>\
         <Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps\" Target=\"presProps.xml\"/>\
         <Relationship Id=\"rId4\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps\" Target=\"viewProps.xml\"/>\
         <Relationship Id=\"rId5\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles\" Target=\"tableStyles.xml\"/>",
    );
    for (n, slide) in slides.iter().enumerate() {
        let i = n + 1;
        let _ = write!(
            types,
            "<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
        );
        let _ = write!(ids, "<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 255 + i, 5 + i);
        let _ = write!(
            rels,
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{i}.xml\"/>",
            5 + i
        );
        let (layout, shapes) = if n == 0 {
            (
                1,
                format!(
                    "{}{}",
                    placeholder(2, "Title 1", "type=\"ctrTitle\"", None, &paragraphs(&[slide.title])),
                    placeholder(3, "Subtitle 2", "type=\"subTitle\" idx=\"1\"", None, &paragraphs(slide.points))
                ),
            )
        } else {
            (
                2,
                format!(
                    "{}{}",
                    placeholder(2, "Title 1", "type=\"title\"", None, &paragraphs(&[slide.title])),
                    placeholder(3, "Content 2", "idx=\"1\"", None, &paragraphs(slide.points))
                ),
            )
        };
        parts.push((
            format!("ppt/slides/slide{i}.xml"),
            format!("{HEAD}<p:sld {NS}><p:cSld><p:spTree>{GROUP}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"),
        ));
        parts.push((
            format!("ppt/slides/_rels/slide{i}.xml.rels"),
            format!(
                "{HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" \
                 Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout{layout}.xml\"/></Relationships>"
            ),
        ));
    }
    types.push_str("</Types>");
    rels.push_str("</Relationships>");
    parts.push(("[Content_Types].xml".into(), format!("{HEAD}{types}")));
    parts.push((
        "_rels/.rels".into(),
        format!(
            "{HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/>\
             <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
             <Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>"
        ),
    ));
    parts.push((
        "docProps/core.xml".into(),
        format!(
            "{HEAD}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\
             <dc:title>{}</dc:title><dc:creator>Ferrum</dc:creator></cp:coreProperties>",
            xml(title)
        ),
    ));
    parts.push((
        "docProps/app.xml".into(),
        format!(
            "{HEAD}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Ferrum</Application><Slides>{}</Slides></Properties>",
            slides.len()
        ),
    ));
    parts.push((
        "ppt/presentation.xml".into(),
        format!(
            "{HEAD}<p:presentation {NS} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
             <p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"{W}\" cy=\"{H}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/>\
             <p:defaultTextStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr></p:defaultTextStyle></p:presentation>"
        ),
    ));
    parts.push(("ppt/_rels/presentation.xml.rels".into(), format!("{HEAD}{rels}")));
    parts.push(("ppt/presProps.xml".into(), format!("{HEAD}<p:presentationPr {NS}/>")));
    parts.push((
        "ppt/viewProps.xml".into(),
        format!(
            "{HEAD}<p:viewPr {NS}><p:normalViewPr><p:restoredLeft sz=\"15620\"/><p:restoredTop sz=\"94660\"/></p:normalViewPr>\
             <p:slideViewPr><p:cSldViewPr><p:cViewPr varScale=\"1\"><p:scale><a:sx n=\"100\" d=\"100\"/><a:sy n=\"100\" d=\"100\"/></p:scale><p:origin x=\"0\" y=\"0\"/></p:cViewPr>\
             <p:guideLst/></p:cSldViewPr></p:slideViewPr><p:gridSpacing cx=\"76200\" cy=\"76200\"/></p:viewPr>"
        ),
    ));
    parts.push((
        "ppt/tableStyles.xml".into(),
        format!("{HEAD}<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"{{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}}\"/>"),
    ));
    let text = |size: u32, bold: bool| {
        format!(
            "<a:defRPr sz=\"{size}\"{}><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/></a:defRPr>",
            if bold { " b=\"1\"" } else { "" }
        )
    };
    let mut body_style = String::new();
    for (lvl, (size, indent)) in [(2400u32, 342_900u32), (2000, 742_950), (1800, 1_143_000)].iter().enumerate() {
        let bullet = ["\u{2022}", "\u{2013}", "\u{2022}"][lvl];
        let _ = write!(
            body_style,
            "<a:lvl{n}pPr marL=\"{indent}\" indent=\"-342900\"><a:spcBef><a:spcPts val=\"600\"/></a:spcBef><a:buFont typeface=\"Arial\"/><a:buChar char=\"{bullet}\"/>{}</a:lvl{n}pPr>",
            text(*size, false),
            n = lvl + 1
        );
    }
    parts.push((
        "ppt/slideMasters/slideMaster1.xml".into(),
        format!(
            "{HEAD}<p:sldMaster {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val=\"bg1\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>{GROUP}{}{}</p:spTree></p:cSld>\
             <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
             <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/><p:sldLayoutId id=\"2147483650\" r:id=\"rId2\"/></p:sldLayoutIdLst>\
             <p:txStyles><p:titleStyle><a:lvl1pPr algn=\"l\"><a:defRPr sz=\"4000\" b=\"1\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mj-lt\"/></a:defRPr></a:lvl1pPr></p:titleStyle>\
             <p:bodyStyle>{body_style}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>",
            placeholder(2, "Title Placeholder 1", "type=\"title\"", title_box, &paragraphs(&["Title"])),
            placeholder(3, "Text Placeholder 2", "type=\"body\" idx=\"1\"", body_box, &paragraphs(&["Text"])),
        ),
    ));
    parts.push((
        "ppt/slideMasters/_rels/slideMaster1.xml.rels".into(),
        format!(
            "{HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
             <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout2.xml\"/>\
             <Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/></Relationships>"
        ),
    ));
    let layouts = [
        (
            "title",
            "Title Slide",
            format!(
                "{}{}",
                placeholder(2, "Title 1", "type=\"ctrTitle\"", Some((1_524_000, 1_122_363, W - 2 * 1_524_000, 2_387_600)), &paragraphs(&["Title"])),
                placeholder(
                    3,
                    "Subtitle 2",
                    "type=\"subTitle\" idx=\"1\"",
                    Some((1_524_000, 3_602_038, W - 2 * 1_524_000, 1_655_762)),
                    &paragraphs(&["Subtitle"])
                )
            ),
        ),
        (
            "obj",
            "Title and Content",
            format!(
                "{}{}",
                placeholder(2, "Title 1", "type=\"title\"", None, &paragraphs(&["Title"])),
                placeholder(3, "Content 2", "idx=\"1\"", None, &paragraphs(&["Text"]))
            ),
        ),
    ];
    for (i, (kind, name, shapes)) in layouts.iter().enumerate() {
        let n = i + 1;
        parts.push((
            format!("ppt/slideLayouts/slideLayout{n}.xml"),
            format!("{HEAD}<p:sldLayout {NS} type=\"{kind}\" preserve=\"1\"><p:cSld name=\"{name}\"><p:spTree>{GROUP}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"),
        ));
        parts.push((
            format!("ppt/slideLayouts/_rels/slideLayout{n}.xml.rels"),
            format!(
                "{HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" \
                 Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>"
            ),
        ));
    }
    let solid = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
    let colours = [
        ("dk1", "1F2328"),
        ("lt1", "FFFFFF"),
        ("dk2", "24292F"),
        ("lt2", "F6F8FA"),
        ("accent1", "2563EB"),
        ("accent2", "16A34A"),
        ("accent3", "D97706"),
        ("accent4", "DC2626"),
        ("accent5", "7C3AED"),
        ("accent6", "0891B2"),
        ("hlink", "0969DA"),
        ("folHlink", "8250DF"),
    ];
    let scheme: String = colours.iter().map(|(n, c)| format!("<a:{n}><a:srgbClr val=\"{c}\"/></a:{n}>")).collect();
    parts.push((
        "ppt/theme/theme1.xml".into(),
        format!(
            "{HEAD}<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Ferrum\"><a:themeElements><a:clrScheme name=\"Ferrum\">{scheme}</a:clrScheme>\
             <a:fontScheme name=\"Ferrum\"><a:majorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont>\
             <a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme>\
             <a:fmtScheme name=\"Ferrum\"><a:fillStyleLst>{solid}{solid}{solid}</a:fillStyleLst>\
             <a:lnStyleLst><a:ln w=\"6350\">{solid}</a:ln><a:ln w=\"12700\">{solid}</a:ln><a:ln w=\"19050\">{solid}</a:ln></a:lnStyleLst>\
             <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\
             <a:bgFillStyleLst>{solid}{solid}{solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
        ),
    ));
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let failed = |e: &dyn std::fmt::Display| Error::internal(format!("building a presentation: {e}"));
    // [Content_Types].xml first, as Office expects.
    parts.sort_by_key(|(name, _)| name != "[Content_Types].xml");
    for (name, data) in parts {
        zip.start_file(name, opts).map_err(|e| failed(&e))?;
        zip.write_all(data.as_bytes()).map_err(|e| failed(&e))?;
    }
    Ok(zip.finish().map_err(|e| failed(&e))?.into_inner())
}

// ───────────────────────────── a workspace's own ─────────────────────────────

/// How many templates a workspace keeps.
const MAX_TEMPLATES: i64 = 200;

fn manage(ctx: &Ctx) -> Result<()> {
    if acl::is_admin(ctx) { Ok(()) } else { Err(Error::Forbidden("only Drive administrators manage the workspace's templates".into())) }
}

fn kind_param(p: &Params<'_>) -> Result<Option<&'static str>> {
    match p.str("kind") {
        None | Some("") => Ok(None),
        Some(k) => KINDS.iter().copied().find(|x| *x == k).map(Some).ok_or_else(|| Error::field("kind", format!("must be one of {}", KINDS.join(", ")))),
    }
}

/// `name` (else `fallback`) as a file of `kind`: `Q3 budget` → `Q3 budget.xlsx`; a name already
/// ending so keeps it.
pub fn file_name(name: Option<&str>, fallback: &str, kind: &str) -> String {
    let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(fallback);
    if content::extension(name) == kind { name.to_string() } else { format!("{name}.{kind}") }
}

/// `list_templates` (`kind`): what new Office files may start from, Drive's own first, then the
/// workspace's; `manage` says whether the caller may add and remove the workspace's.
pub async fn list(tx: &mut Tx, ctx: &Ctx, p: &Params<'_>) -> Out {
    let kind = kind_param(p)?;
    let mut out: Vec<Value> = BUILTIN
        .iter()
        .filter(|b| kind.is_none_or(|k| k == b.kind))
        .map(|b| json!({"id": b.id, "kind": b.kind, "title": b.title, "category": b.category, "description": b.description, "builtin": true}))
        .collect();
    let rows: Vec<(Uuid, String, String, Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "select id, title, file_kind, category, description, size from e_drive_template where tenant_id = $1 and ($2::text is null or file_kind = $2) \
         order by lower(title), id",
    )
    .bind(ctx.tenant)
    .bind(kind)
    .fetch_all(&mut **tx)
    .await?;
    out.extend(rows.into_iter().map(|(id, title, kind, category, description, size)| {
        json!({"id": id, "kind": kind, "title": title, "category": category, "description": description, "size": size, "builtin": false})
    }));
    Ok(json!({"templates": out, "manage": acl::is_admin(ctx)}))
}

/// A template found by [`find`]: what it makes, and where its bytes come from.
pub struct Template {
    pub kind: String,
    pub title: String,
    source: Source,
}

enum Source {
    Builtin(fn() -> Result<Vec<u8>>),
    Stored(Uuid),
}

impl Template {
    pub async fn bytes(&self, k: &Kernel, ctx: &Ctx) -> Result<Vec<u8>> {
        match self.source {
            Source::Builtin(make) => make(),
            Source::Stored(object) => files::read(k, ctx, object).await,
        }
    }
}

/// Template `id`: one of Drive's (by its name, `budget`) or the workspace's (by its id).
pub async fn find(tx: &mut Tx, tenant: Uuid, id: &str) -> Result<Template> {
    if let Some(b) = BUILTIN.iter().find(|b| b.id == id) {
        return Ok(Template { kind: b.kind.into(), title: b.title.into(), source: Source::Builtin(b.make) });
    }
    let missing = || Error::NotFound("template".into());
    let id: Uuid = id.parse().map_err(|_| missing())?;
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("select title, file_kind, stored_file from e_drive_template where tenant_id = $1 and id = $2")
            .bind(tenant)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let (title, kind, object) = row.ok_or_else(missing)?;
    let object = object.and_then(|o| o.parse().ok()).ok_or_else(missing)?;
    Ok(Template { kind, title, source: Source::Stored(object) })
}

/// `create_from_template` (`template`, `folder`, `name`): a new Office file from a template, in a
/// folder the caller may edit (their top folder unless given), named after the template unless
/// `name` says otherwise; a taken name gets a number.
pub async fn create(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, space: &Space, p: &Params<'_>) -> Out {
    let t = find(tx, ctx.tenant, p.req("template")?).await?;
    let data = t.bytes(k, ctx).await?;
    let c = Content::new(&file_name(p.str("name"), &t.title, &t.kind), &data);
    files::upload(k, ctx, tx, g, p.uuid("folder")?.unwrap_or(space.root), &c, OnConflict::KeepBoth, None).await
}

/// `save_as_template` (`file`, `title`, `category`, `description`): a Drive administrator saves an
/// Office file they may view as one of the workspace's templates, which keeps its own copy of the
/// file's current version.
pub async fn save(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    manage(ctx)?;
    let file = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::View, false).await?;
    let kind = content::extension(&file.name);
    let office = |t: &str| t != content::FDOC && ["Document", "Spreadsheet", "Presentation"].contains(&content::file_type(t));
    let (object, _, size, _, ctype) = files::version(tx, ctx.tenant, &file, None).await?;
    if !KINDS.contains(&kind.as_str()) || !ctype.as_deref().is_some_and(office) {
        return Err(Error::field("file", "a template is a document, spreadsheet or presentation (docx, xlsx, pptx, odt, ods or odp)"));
    }
    if size as usize > MAX_TEMPLATE {
        return Err(Error::field("file", format!("templates are limited to {} MB", MAX_TEMPLATE >> 20)));
    }
    // One save at a time per workspace, so the limit holds exactly.
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('drive-templates:' || $1::text, 0))").bind(ctx.tenant).execute(&mut **tx).await?;
    let count: i64 = sqlx::query_scalar("select count(*) from e_drive_template where tenant_id = $1").bind(ctx.tenant).fetch_one(&mut **tx).await?;
    if count >= MAX_TEMPLATES {
        return Err(Error::invalid(format!("a workspace keeps at most {MAX_TEMPLATES} templates: delete one first")));
    }
    let text = |key: &str, max: usize| p.str(key).map(str::trim).filter(|v| !v.is_empty()).map(|v| v.chars().take(max).collect::<String>());
    let title = text("title", 140).unwrap_or_else(|| content::stem(&file.name, false).to_string());
    let bytes = files::read(k, ctx, object).await?;
    let copy = files::put_object(k, ctx, &Content::new(&file.name, &bytes)).await?;
    let id = Uuid::now_v7();
    let mut doc = Doc::new();
    for (key, v) in [
        ("id", json!(id)),
        ("title", json!(title)),
        ("file_kind", json!(kind)),
        ("category", json!(text("category", 60))),
        ("description", json!(text("description", 280))),
        ("stored_file", json!(copy.to_string())),
        ("size", json!(bytes.len())),
        ("made_from", json!(file.name)),
    ] {
        doc.insert(key.into(), v);
    }
    let res = async {
        k.insert_tx(&elevated(ctx), tx, "DriveTemplate", doc).await?;
        files::attach_to(tx, ctx.tenant, copy, "DriveTemplate", id).await
    }
    .await;
    if let Err(e) = res {
        files::discard(k, ctx, copy).await;
        return Err(e);
    }
    Ok(json!({"id": id, "kind": kind, "title": title, "builtin": false}))
}

/// `delete_template` (`template`): a Drive administrator removes one of the workspace's templates;
/// files made from it stay as they are.
pub async fn delete(k: &Kernel, ctx: &Ctx, tx: &mut Tx, p: &Params<'_>) -> Out {
    manage(ctx)?;
    let id = p.req("template")?;
    if BUILTIN.iter().any(|b| b.id == id) {
        return Err(Error::invalid("Drive's own templates cannot be deleted"));
    }
    let id: Uuid = id.parse().map_err(|_| Error::NotFound("template".into()))?;
    k.delete_tx(&elevated(ctx), tx, "DriveTemplate", id, None).await?;
    let keys: Vec<String> =
        sqlx::query_scalar("delete from file_object where tenant_id = $1 and entity = 'DriveTemplate' and record_id = $2 returning storage_key")
            .bind(ctx.tenant)
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
    ferrum_kernel::outbox::release_objects(tx, ctx.tenant, &keys).await?;
    Ok(json!({"deleted": id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    fn parts(file: &[u8]) -> Vec<String> {
        let z = zip::ZipArchive::new(std::io::Cursor::new(file)).expect("a zip");
        z.file_names().map(|n| n.expect("a name").into_owned()).collect()
    }

    #[test]
    fn every_template_is_a_file_of_its_kind() {
        for b in BUILTIN {
            let file = (b.make)().unwrap_or_else(|e| panic!("{}: {e}", b.id));
            let names = parts(&file);
            let main = match b.kind {
                "docx" => "word/document.xml",
                "xlsx" => "xl/workbook.xml",
                _ => "ppt/presentation.xml",
            };
            assert!(names.iter().any(|n| n == main) && names.iter().any(|n| n == "[Content_Types].xml"), "{}: {names:?}", b.id);
            if let Ok(dir) = std::env::var("FERRUM_TEMPLATE_SAMPLES") {
                std::fs::write(format!("{dir}/{}.{}", b.id, b.kind), &file).unwrap();
            }
        }
    }

    #[test]
    fn a_presentation_has_its_slides_and_words() {
        let file = project_update().unwrap();
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(&file[..])).unwrap();
        let mut s = String::new();
        z.by_name("ppt/slides/slide3.xml").unwrap().read_to_string(&mut s).unwrap();
        assert!(s.contains("<a:t>What is next</a:t>") && s.contains("<p:ph type=\"title\"/>"), "{s}");
        let mut p = String::new();
        z.by_name("ppt/presentation.xml").unwrap().read_to_string(&mut p).unwrap();
        assert_eq!(p.matches("<p:sldId ").count(), 4);
        assert_eq!(xml("Q&A <draft>"), "Q&amp;A &lt;draft&gt;");
    }
}
