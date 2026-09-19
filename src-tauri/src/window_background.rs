//! The native window background, from the persisted theme.
//!
//! The window is opaque and is shown before the webview has painted anything,
//! so whatever colour it carries IS the launch flash. Hardcoding black meant
//! every non-black theme — and every light variant — opened on a black frame
//! and then jumped. Rust already parses themes (`atlas-theme`), and the chosen
//! theme is in `config.toml` before the webview starts loading, so the right
//! colour is available at exactly the moment it is needed.
//!
//! The web half of the same flash lives in `index.html`, which replays the last
//! run's colours out of `localStorage`. Two mechanisms because they run at
//! different times: this one is before the webview exists, that one is before
//! the first stylesheet.
//!
//! Only the `background` BASE TOKEN is read — no derivation. Resolution proper
//! happens in TypeScript (decision 14) and this is the one value every theme
//! sets verbatim, so there is nothing here for the two to disagree about.

use crate::state::atlas_config::ThemeMode;
use atlas_theme::Theme;
use tauri::window::Color;

/// What Atlas has always opened on, and what a theme that cannot be read or
/// whose background is not a plain hex colour still opens on.
pub const FALLBACK: Color = Color(0, 0, 0, 255);

/// The window background for `theme_id` under `mode`.
///
/// `system_is_light` is the OS appearance, used only when the mode is
/// `System` — the same question `appearanceForMode` answers in TypeScript.
pub fn window_background(theme_id: &str, mode: ThemeMode, system_is_light: bool) -> Color {
    let Ok(theme) = atlas_theme::get_theme(theme_id) else {
        return FALLBACK;
    };
    background_of(&theme, mode, system_is_light).unwrap_or(FALLBACK)
}

fn background_of(theme: &Theme, mode: ThemeMode, system_is_light: bool) -> Option<Color> {
    let wants_light = match mode {
        ThemeMode::Light => true,
        ThemeMode::Dark => false,
        ThemeMode::System => system_is_light,
    };
    // Same fallback order as `chooseVariant` in `resolve-theme.ts`: the
    // requested variant, then whichever one the theme does have.
    let variant = if wants_light {
        theme.light.as_ref().or(theme.dark.as_ref())
    } else {
        theme.dark.as_ref().or(theme.light.as_ref())
    }?;
    parse_hex(variant.base.get("background")?)
}

/// `#rgb`, `#rrggbb` and `#rrggbbaa`. Every built-in theme writes hex; anything
/// else (a theme author's `oklch()`) returns `None` and keeps the fallback,
/// which is one frame of the old behaviour rather than a wrong colour.
fn parse_hex(value: &str) -> Option<Color> {
    let digits = value.trim().strip_prefix('#')?;
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |slice: &str| u8::from_str_radix(slice, 16).ok();
    match digits.len() {
        3 => {
            let d: Vec<u8> = digits
                .chars()
                .map(|c| byte(&format!("{c}{c}")))
                .collect::<Option<_>>()?;
            Some(Color(d[0], d[1], d[2], 255))
        }
        6 | 8 => Some(Color(
            byte(&digits[0..2])?,
            byte(&digits[2..4])?,
            byte(&digits[4..6])?,
            // A translucent base token would make the window see-through, which
            // is the compositor cost the opaque window exists to avoid.
            255,
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_theme::ThemeVariant;

    /// A variant carrying only the one base token this module reads. Built by
    /// hand rather than parsed, because the loader rightly rejects a TOML theme
    /// that is missing any of the other 43 required base tokens.
    fn variant(background: &str) -> ThemeVariant {
        ThemeVariant {
            base: [("background".to_string(), background.to_string())]
                .into_iter()
                .collect(),
            palette: Default::default(),
            keys: Default::default(),
        }
    }

    fn theme(dark: Option<&str>, light: Option<&str>) -> Theme {
        Theme {
            schema: 1,
            id: "test".into(),
            name: "Test".into(),
            author: "Atlas".into(),
            license: "MIT".into(),
            dark: dark.map(variant),
            light: light.map(variant),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn mode_picks_the_variant() {
        let t = theme(Some("#191724"), Some("#faf4ed"));
        assert_eq!(
            background_of(&t, ThemeMode::Dark, true),
            Some(Color(0x19, 0x17, 0x24, 255))
        );
        assert_eq!(
            background_of(&t, ThemeMode::Light, false),
            Some(Color(0xfa, 0xf4, 0xed, 255))
        );
    }

    #[test]
    fn system_mode_follows_the_os() {
        let t = theme(Some("#191724"), Some("#faf4ed"));
        assert_eq!(
            background_of(&t, ThemeMode::System, true),
            Some(Color(0xfa, 0xf4, 0xed, 255))
        );
        assert_eq!(
            background_of(&t, ThemeMode::System, false),
            Some(Color(0x19, 0x17, 0x24, 255))
        );
    }

    #[test]
    fn a_missing_variant_falls_back_to_the_other() {
        let t = theme(Some("#0a0a0a"), None);
        assert_eq!(
            background_of(&t, ThemeMode::Light, true),
            Some(Color(0x0a, 0x0a, 0x0a, 255))
        );
    }

    #[test]
    fn hex_forms() {
        assert_eq!(parse_hex("#abc"), Some(Color(0xaa, 0xbb, 0xcc, 255)));
        assert_eq!(parse_hex(" #0A0A0A "), Some(Color(10, 10, 10, 255)));
        // Alpha is read but discarded: the window stays opaque.
        assert_eq!(parse_hex("#10203080"), Some(Color(0x10, 0x20, 0x30, 255)));
        assert_eq!(parse_hex("oklch(0.2 0 0)"), None);
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("#gggggg"), None);
    }

    /// The whole point of the feature: no shipped theme may fall back to black.
    #[test]
    fn every_built_in_theme_yields_a_colour() {
        for theme in atlas_theme::built_in_themes().expect("built-ins load") {
            for mode in [ThemeMode::Dark, ThemeMode::Light, ThemeMode::System] {
                assert!(
                    background_of(&theme, mode, true).is_some(),
                    "{} has no launch background in {mode:?}",
                    theme.id
                );
            }
        }
    }
}
