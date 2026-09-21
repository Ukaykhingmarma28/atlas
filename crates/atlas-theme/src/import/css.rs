//! A very small CSS reader, for the shadcn `globals.css` shape only.
//!
//! This is not a CSS parser and must not grow into one. It answers exactly one
//! question — "what custom properties does this file set, and in which of
//! `:root` / `.dark` / `@theme`?" — because that is the whole of what a shadcn
//! theme is when someone pastes it out of their project instead of exporting a
//! registry item. Anything else in the file (real rules, `@import`, keyframes)
//! is skipped by construction: a block whose selector we do not recognise
//! contributes nothing.
//!
//! It does handle nesting, because `@layer base { :root { … } }` is the shape
//! `shadcn init` writes and refusing it would reject the most common paste.

use std::collections::BTreeMap;

/// The custom properties of one selector, in `--name` → value form with the
/// leading dashes stripped and the CSS cascade already applied (last wins).
pub type Declarations = BTreeMap<String, String>;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct StyleSheet {
    /// `:root`, `html`, `:host` — shadcn's light variant by convention.
    pub root: Declarations,
    /// `.dark`, `[data-theme="dark"]`, `.dark *`.
    pub dark: Declarations,
    /// `@theme` / `@theme inline` — Tailwind v4's namespace block, where
    /// tweakcn parks the fonts, radius, tracking and spacing.
    pub theme: Declarations,
    /// Selectors we saw and did nothing with. Reported, not discarded, so a
    /// paste that produced nothing can say why.
    pub other_selectors: Vec<String>,
}

impl StyleSheet {
    pub fn is_empty(&self) -> bool {
        self.root.is_empty() && self.dark.is_empty() && self.theme.is_empty()
    }
}

pub fn parse(css: &str) -> StyleSheet {
    let mut sheet = StyleSheet::default();
    collect(&strip_comments(css), &mut sheet, 0);
    sheet
}

fn collect(css: &str, sheet: &mut StyleSheet, depth: usize) {
    // `@layer base { @layer x { … } }` is legal but nobody writes it deep;
    // the cap is only here so a pathological paste cannot recurse forever.
    if depth > 4 {
        return;
    }
    for (selector, body) in blocks(css) {
        let head = selector.trim();
        if head.starts_with("@layer") || head.starts_with("@media") || head.starts_with("@supports") {
            collect(&body, sheet, depth + 1);
            continue;
        }
        let target = if head.starts_with("@theme") {
            Some(&mut sheet.theme)
        } else if is_dark_selector(head) {
            Some(&mut sheet.dark)
        } else if is_root_selector(head) {
            Some(&mut sheet.root)
        } else {
            None
        };
        match target {
            Some(target) => {
                for (name, value) in declarations(&body) {
                    target.insert(name, value);
                }
            }
            None => sheet.other_selectors.push(head.to_string()),
        }
    }
}

fn is_root_selector(selector: &str) -> bool {
    selector
        .split(',')
        .map(str::trim)
        .any(|part| matches!(part, ":root" | "html" | ":host" | ":root,:host"))
}

fn is_dark_selector(selector: &str) -> bool {
    selector.split(',').map(str::trim).any(|part| {
        part == ".dark"
            || part.starts_with(".dark ")
            || part.starts_with(".dark:")
            || part.contains("[data-theme=\"dark\"]")
            || part.contains("[data-theme='dark']")
            || part.contains("prefers-color-scheme: dark")
    })
}

/// Top-level `selector { body }` pairs, by brace counting.
fn blocks(css: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = css.chars().collect();
    let mut index = 0;
    let mut selector_start = 0;
    while index < chars.len() {
        match chars[index] {
            '{' => {
                let selector: String = chars[selector_start..index].iter().collect();
                let mut depth = 1;
                let body_start = index + 1;
                index += 1;
                while index < chars.len() && depth > 0 {
                    match chars[index] {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        _ => {}
                    }
                    index += 1;
                }
                let body_end = if depth == 0 { index - 1 } else { chars.len() };
                out.push((selector.trim().to_string(), chars[body_start..body_end].iter().collect()));
                selector_start = index;
            }
            ';' if out.is_empty() || selector_start == index => {
                // A stray top-level statement (`@import …;`). Skip it.
                index += 1;
                selector_start = index;
            }
            _ => index += 1,
        }
    }
    out
}

/// `--name: value;` pairs from a block body, ignoring nested blocks and any
/// ordinary (non-custom) property.
fn declarations(body: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for statement in split_top_level(body) {
        let Some((name, value)) = statement.split_once(':') else { continue };
        let name = name.trim();
        let Some(name) = name.strip_prefix("--") else { continue };
        let value = value.trim().trim_end_matches(';').trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        out.push((name.to_string(), value.to_string()));
    }
    out
}

/// Split on `;` that are not inside `(` … `)` or a nested block.
fn split_top_level(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut parens = 0usize;
    let mut braces = 0usize;
    for ch in body.chars() {
        match ch {
            '(' => parens += 1,
            ')' => parens = parens.saturating_sub(1),
            '{' => {
                braces += 1;
                // Everything up to here was the nested block's selector.
                current.clear();
                continue;
            }
            '}' => {
                braces = braces.saturating_sub(1);
                current.clear();
                continue;
            }
            ';' if parens == 0 && braces == 0 => {
                out.push(std::mem::take(&mut current));
                continue;
            }
            _ => {}
        }
        if braces == 0 {
            current.push(ch);
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let bytes: Vec<char> = css.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == '/' && bytes.get(index + 1) == Some(&'*') {
            index += 2;
            while index < bytes.len() && !(bytes[index] == '*' && bytes.get(index + 1) == Some(&'/')) {
                index += 1;
            }
            index += 2;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

/// Is this `@theme` entry an alias rather than a value?
///
/// Tailwind v4's `@theme inline` block is mostly `--color-background:
/// var(--background)` — a re-export of a property declared in `:root`, not a
/// colour. Following it would record the literal string `var(--background)` as
/// a theme value and fail Atlas's colour validation on the way out.
pub fn is_alias(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("var(") || value.starts_with("calc(")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
        /* a comment { with braces } */
        @import "tailwindcss";
        :root {
          --background: oklch(1 0 0);
          --radius: 0.625rem;
        }
        .dark {
          --background: oklch(0.145 0 0);
        }
        @theme inline {
          --color-background: var(--background);
          --font-sans: Inter, sans-serif;
        }
        @layer base {
          :root { --spacing: 0.25rem; }
          * { border-color: var(--border); }
        }
        .prose h1 { color: red; }
    "#;

    #[test]
    fn reads_the_shadcn_globals_shape() {
        let sheet = parse(SAMPLE);
        assert_eq!(sheet.root.get("background").unwrap(), "oklch(1 0 0)");
        assert_eq!(sheet.root.get("radius").unwrap(), "0.625rem");
        assert_eq!(sheet.root.get("spacing").unwrap(), "0.25rem", "nested in @layer base");
        assert_eq!(sheet.dark.get("background").unwrap(), "oklch(0.145 0 0)");
        assert_eq!(sheet.theme.get("font-sans").unwrap(), "Inter, sans-serif");
        assert!(is_alias(sheet.theme.get("color-background").unwrap()));
        assert!(sheet.other_selectors.iter().any(|s| s.contains(".prose")));
    }

    #[test]
    fn a_file_with_no_custom_properties_is_empty_not_wrong() {
        assert!(parse("body { color: red; }").is_empty());
    }
}
