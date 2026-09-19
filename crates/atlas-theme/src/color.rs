//! Just enough colour maths to make an import decision.
//!
//! The importers never *convert* a colour — decision 15 is a one-time
//! conversion and the author's own notation is what lands in the TOML, so an
//! oklch theme stays oklch. What they do need is two judgements:
//!
//!  - is this variant dark or light? (a pasted `:root` block carries no
//!    appearance, and shadcn's `:root` is conventionally the *light* one, so
//!    guessing from the value beats trusting the selector)
//!  - of two candidate colours, which reads against this one? (shadcn's newer
//!    registry drops `destructive-foreground`; picking the wrong side of it
//!    gives red-on-red)
//!
//! Both only need an ordering, not a colorimetrically exact number, so this
//! deliberately mixes scales: WCAG relative luminance for sRGB inputs, and the
//! `L` channel as-is for `hsl()` and `oklch()`. Those are not the same quantity
//! — oklch `L` is perceptual, WCAG luminance is linear-light — and comparing
//! across them would be wrong. Every caller compares colours that came out of
//! the same theme file in the same notation, which is why this is safe here and
//! is not a general-purpose colour library.

/// A rough lightness in `0.0..=1.0`, or `None` for a notation we do not read.
pub fn lightness(value: &str) -> Option<f64> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let (r, g, b) = parse_hex(hex)?;
        return Some(relative_luminance(r, g, b));
    }
    let (name, body) = split_function(value)?;
    let parts = channels(&body);
    match name {
        "rgb" | "rgba" => {
            let [r, g, b] = first_three(&parts)?;
            Some(relative_luminance(
                scale_channel(r, &parts[0]),
                scale_channel(g, &parts[1]),
                scale_channel(b, &parts[2]),
            ))
        }
        // `hsl()`'s third channel and `oklch()`'s first are both a lightness.
        "hsl" | "hsla" => parts.get(2).and_then(|part| number(part)).map(percent_to_unit),
        "oklch" => parts.first().and_then(|part| number(part)).map(percent_to_unit),
        _ => None,
    }
}

/// Is `value` a dark colour? Unreadable notations answer `None`.
pub fn is_dark(value: &str) -> Option<bool> {
    lightness(value).map(|light| light < 0.5)
}

/// Of `a` and `b`, the one further in lightness from `against`.
///
/// Used wherever a foreground has to be invented for a surface the source
/// theme gave no foreground for. Falls back to `a` when nothing parses, so the
/// caller still gets a value and the report still says it was derived.
pub fn better_contrast<'a>(against: &str, a: &'a str, b: &'a str) -> &'a str {
    let (Some(base), Some(la), Some(lb)) = (lightness(against), lightness(a), lightness(b)) else {
        return a;
    };
    if (la - base).abs() >= (lb - base).abs() {
        a
    } else {
        b
    }
}

fn split_function(value: &str) -> Option<(&str, String)> {
    let open = value.find('(')?;
    let close = value.rfind(')')?;
    if close < open {
        return None;
    }
    Some((&value[..open], value[open + 1..close].to_string()))
}

fn channels(body: &str) -> Vec<String> {
    body.replace(',', " ")
        .split('/')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect()
}

fn first_three(parts: &[String]) -> Option<[f64; 3]> {
    if parts.len() < 3 {
        return None;
    }
    Some([number(&parts[0])?, number(&parts[1])?, number(&parts[2])?])
}

fn number(part: &str) -> Option<f64> {
    part.trim_end_matches('%').trim_end_matches("deg").parse::<f64>().ok().filter(|n| n.is_finite())
}

/// `50%` is a half; a bare number in `rgb()` is 0–255.
fn scale_channel(value: f64, raw: &str) -> f64 {
    if raw.ends_with('%') {
        (value / 100.0).clamp(0.0, 1.0)
    } else {
        (value / 255.0).clamp(0.0, 1.0)
    }
}

fn percent_to_unit(value: f64) -> f64 {
    let unit = if value > 1.0 { value / 100.0 } else { value };
    unit.clamp(0.0, 1.0)
}

fn parse_hex(hex: &str) -> Option<(f64, f64, f64)> {
    let digits: Vec<u8> = hex.bytes().map(|b| (b as char).to_digit(16).map(|d| d as u8)).collect::<Option<_>>()?;
    let (r, g, b) = match digits.len() {
        3 | 4 => (digits[0] * 17, digits[1] * 17, digits[2] * 17),
        6 | 8 => (
            digits[0] * 16 + digits[1],
            digits[2] * 16 + digits[3],
            digits[4] * 16 + digits[5],
        ),
        _ => return None,
    };
    Some((f64::from(r) / 255.0, f64::from(g) / 255.0, f64::from(b) / 255.0))
}

fn relative_luminance(r: f64, g: f64, b: f64) -> f64 {
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

fn linearize(channel: f64) -> f64 {
    if channel <= 0.039_28 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_notation_a_theme_may_use() {
        assert!(is_dark("#000000").unwrap());
        assert!(!is_dark("#ffffff").unwrap());
        assert!(is_dark("#191724ff").unwrap(), "zed writes 8-digit hex");
        assert!(!is_dark("oklch(0.98 0.01 90)").unwrap(), "tweakcn writes oklch");
        assert!(is_dark("hsl(240 5% 6%)").unwrap());
        assert!(is_dark("rgb(20 20 20)").unwrap());
        assert!(!is_dark("rgb(90% 90% 90%)").unwrap());
        assert_eq!(is_dark("var(--nope)"), None);
    }

    #[test]
    fn picks_the_readable_side_of_a_surface() {
        assert_eq!(better_contrast("#b4637a", "#ffffff", "#000000"), "#ffffff");
        assert_eq!(better_contrast("#f6c177", "#ffffff", "#191724"), "#191724");
        // Nothing parses: the caller still gets a value rather than an Option.
        assert_eq!(better_contrast("var(--x)", "#aaa", "#bbb"), "#aaa");
    }
}
