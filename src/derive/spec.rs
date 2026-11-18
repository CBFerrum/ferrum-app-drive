//! What an `image` result is asked as (design S7, 2.6): a width and/or a height from a fixed list, a fit, a format and
//! a quality, and a crop; or a preset's name. Anything else is refused, so a picture's results are bounded, and the
//! canonical form (keys in order, defaults filled, quality to a step of 5) is what is digested: equal asks share one
//! result.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// The sides a picture is made at, in pixels.
pub(crate) const SIZES: [u64; 14] = [64, 128, 192, 256, 320, 480, 640, 800, 1024, 1280, 1600, 1920, 2560, 3840];
const FITS: [&str; 3] = ["contain", "cover", "exact"];
const FORMATS: [&str; 3] = ["jpeg", "png", "webp"];
/// JPEG and WebP quality: the least, the most and what is used when none is asked.
const QUALITY: (u64, u64, u64) = (50, 95, 82);

/// The canonical form of an `image` spec, or why it is refused.
pub(crate) fn image(spec: &Value) -> Result<Value, String> {
    let o = spec.as_object().ok_or("an image is asked as an object")?;
    if let Some(p) = o.get("preset") {
        let name = p.as_str().filter(|n| preset_name(n)).ok_or("a preset's name is lower-case letters, digits and -, 40 at most")?;
        if o.len() > 1 {
            return Err("a preset is asked for alone".into());
        }
        return Ok(json!({"preset": name}));
    }
    if let Some(k) = o.keys().find(|k| !["width", "height", "fit", "format", "quality", "crop"].contains(&k.as_str())) {
        return Err(format!("{k} is not part of an image's spec"));
    }
    let side = |k: &str| match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().filter(|n| SIZES.contains(n)).map(Some).ok_or_else(|| format!("{k} is one of {SIZES:?}")),
    };
    let (width, height) = (side("width")?, side("height")?);
    let text = |k: &str, of: &[&'static str], default: &'static str| match o.get(k) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v.as_str().and_then(|s| of.iter().copied().find(|x| *x == s)).ok_or_else(|| format!("{k} is one of {}", of.join(", "))),
    };
    let fit = text("fit", &FITS, "contain")?;
    let format = text("format", &FORMATS, "jpeg")?;
    match (width, height, fit) {
        (None, None, _) => return Err("give a width, a height or both".into()),
        (Some(_), Some(_), _) | (_, _, "contain") => {}
        _ => return Err(format!("{fit} needs a width and a height")),
    }
    let quality = match (format, o.get("quality")) {
        ("png", _) | (_, None | Some(Value::Null)) => None,
        (_, Some(q)) => {
            let q = q.as_u64().filter(|q| (QUALITY.0..=QUALITY.1).contains(q)).ok_or_else(|| format!("quality is {} to {}", QUALITY.0, QUALITY.1))?;
            // Steps of 5, and the default itself.
            Some(if q.abs_diff(QUALITY.2) <= 1 { QUALITY.2 } else { (q + 2) / 5 * 5 })
        }
    };
    let quality = if format == "png" { None } else { Some(quality.unwrap_or(QUALITY.2)) };
    let crop = match o.get("crop") {
        None | Some(Value::Null) => None,
        Some(c) => Some(crop(c)?),
    };
    let mut out = Map::new();
    for (k, v) in [
        ("crop", crop),
        ("fit", Some(json!(fit))),
        ("format", Some(json!(format))),
        ("height", height.map(Value::from)),
        ("quality", quality.map(Value::from)),
        ("width", width.map(Value::from)),
    ] {
        if let Some(v) = v {
            out.insert(k.into(), v);
        }
    }
    Ok(Value::Object(out))
}

/// `{x, y, w, h}` as parts of the picture (0 to 1, inside it, not empty), to four places.
fn crop(c: &Value) -> Result<Value, String> {
    let part = |k: &str| c.get(k).and_then(Value::as_f64).filter(|v| (0.0..=1.0).contains(v)).map(|v| (v * 10_000.0).round() / 10_000.0);
    let bad = || "crop is {x, y, w, h}, parts of the picture from 0 to 1".to_string();
    let (Some(x), Some(y), Some(w), Some(h)) = (part("x"), part("y"), part("w"), part("h")) else { return Err(bad()) };
    if c.as_object().is_none_or(|o| o.len() != 4) || w <= 0.0 || h <= 0.0 || x + w > 1.0 || y + h > 1.0 {
        return Err(bad());
    }
    Ok(json!({"h": h, "w": w, "x": x, "y": y}))
}

fn preset_name(n: &str) -> bool {
    (1..=40).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// What a result is kept by: the hex SHA-256 of its kind, a newline and its canonical spec, written with its keys in
/// order whatever the JSON library keeps; for a cover, the focal point too (a new one is a new result).
pub(crate) fn digest(kind: &str, canonical: &Value, focal: Option<(f64, f64)>) -> String {
    let mut text = format!("{kind}\n");
    write(&mut text, canonical);
    if let (Some((x, y)), Some("cover")) = (focal, canonical.get("fit").and_then(Value::as_str)) {
        text.push_str(&format!("\nfocal {x:.4} {y:.4}"));
    }
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn write(out: &mut String, v: &Value) {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                write(out, &o[k]);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, x);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_canonical_and_bounded() {
        let a = image(&json!({"width": 320, "format": "jpeg"})).unwrap();
        let b = image(&json!({"quality": 82, "fit": "contain", "width": 320, "height": null})).unwrap();
        assert_eq!(a, b, "defaults filled");
        assert_eq!(digest("image", &a, None), digest("image", &b, None));
        assert_eq!(image(&json!({"width": 320, "quality": 87})).unwrap()["quality"], json!(85), "to a step of 5");
        assert_eq!(image(&json!({"width": 320, "quality": 83})).unwrap()["quality"], json!(82), "or the default, near it");
        assert_eq!(image(&json!({"width": 320, "format": "png", "quality": 60})).unwrap().get("quality"), None, "a PNG has none");
        let cover = image(&json!({"width": 640, "height": 480, "fit": "cover"})).unwrap();
        assert_ne!(digest("image", &cover, Some((0.2, 0.3))), digest("image", &cover, Some((0.5, 0.5))), "a cover folds in its focal point");
        assert_eq!(digest("image", &a, Some((0.2, 0.3))), digest("image", &a, None), "a contain does not");
        assert_ne!(digest("thumbnail", &json!({}), None), digest("preview", &json!({}), None));
        assert_eq!(image(&json!({"preset": "hero-wide"})).unwrap(), json!({"preset": "hero-wide"}));
        let cropped = image(&json!({"width": 320, "crop": {"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.5}})).unwrap();
        assert_eq!(cropped["crop"], json!({"h": 0.5, "w": 0.5, "x": 0.1, "y": 0.2}));
    }

    #[test]
    fn spec_refuses_sizes_off_the_list() {
        for bad in [
            json!({"width": 300}),
            json!({"width": 5000}),
            json!({"height": 0}),
            json!({}),
            json!({"width": 320, "fit": "cover"}),
            json!({"width": 320, "fit": "stretch"}),
            json!({"width": 320, "format": "gif"}),
            json!({"width": 320, "quality": 99}),
            json!({"width": 320, "colour": "red"}),
            json!({"width": 320, "crop": {"x": 0.8, "y": 0.0, "w": 0.5, "h": 0.5}}),
            json!({"preset": "Hero Wide"}),
            json!({"preset": "hero", "width": 320}),
            json!("320"),
        ] {
            assert!(image(&bad).is_err(), "{bad}");
        }
    }
}
