//! Zed → Atlas.
//!
//! The near-lossless case, and not by accident: decision 9 modelled Atlas's
//! theme keys on Zed's dotted role names, so most of this file is a table of
//! identities. Where the names differ it is because Atlas's no-leaf-and-prefix
//! rule forbids Zed's shape — Zed has both `border` and `border.variant`, which
//! in Atlas must be `border.default` and `border.variant`.
//!
//! **A family is several themes, not one theme with several variants.** A Zed
//! file is `{name, themes: [{name, appearance, style}]}` and the members are
//! siblings, not a dark/light pair of one design: "Rosé Pine", "Rosé Pine Moon"
//! and "Rosé Pine Dawn" are three themes that happen to ship together. Each one
//! becomes its own Atlas theme with a single variant, which is also how the
//! built-ins already treat that exact family.
//!
//! **What Zed does not have is the shadcn layer.** Its style is a flat map of
//! app roles with no notion of `card` / `popover` / `primary`, so all 45 base
//! tokens are derived — see [`derive_base_tokens`] for the chain, which is
//! reported key by key rather than hidden.
//!
//! **What Atlas does not have** is Zed's icon and player vocabulary, its
//! per-role `.border` triplets, and the editor furniture Atlas draws itself
//! (wrap guides, invisibles, subheaders). Those are counted and categorised in
//! the report rather than dropped in silence.

use serde_json::{Map, Value};

use crate::import::draft::VariantDraft;
use crate::import::report::{Fidelity, ImportReport};
use crate::import::{finish_theme, ImportedTheme, ImportOptions};
use crate::{ThemeError, ThemeKeyValue};

/// Zed style key → Atlas theme key. One source may feed several targets.
const STYLE_MAP: &[(&str, &[&str])] = &[
    ("border", &["border.default"]),
    ("border.variant", &["border.variant"]),
    ("border.focused", &["border.focus"]),
    ("border.selected", &["border.strong"]),
    ("border.disabled", &["border.subtle"]),
    ("element.hover", &["element.hover"]),
    ("element.selected", &["element.selected"]),
    ("element.active", &["element.active"]),
    ("ghost_element.hover", &["ghost_element.hover"]),
    ("ghost_element.selected", &["ghost_element.selected"]),
    ("ghost_element.active", &["ghost_element.active"]),
    ("text.muted", &["text.muted"]),
    ("text.placeholder", &["text.placeholder"]),
    ("text.disabled", &["text.disabled"]),
    ("text.accent", &["text.accent"]),
    ("success", &["status.success.foreground", "comms.unread.foreground", "comms.unread_strong.foreground"]),
    ("warning", &["status.warning.foreground"]),
    ("error", &["status.error.foreground"]),
    ("info", &["status.info.foreground"]),
    ("created", &["diff.added.text", "stat.added"]),
    ("created.background", &["diff.added.background", "diff.add_line.background", "diff.add_side.background", "diff.emphasis_added.background"]),
    ("deleted", &["diff.removed.text", "stat.removed"]),
    ("deleted.background", &["diff.removed.background", "diff.remove_line.background", "diff.remove_side.background", "diff.emphasis_removed.background"]),
    ("modified.background", &["diff.modified.background"]),
    ("editor.background", &["editor.background", "diff.context.background", "panel.input.background", "scrollbar.track.background"]),
    ("editor.foreground", &["editor.foreground", "editor.caret"]),
    ("editor.gutter.background", &["editor.gutter.background"]),
    ("editor.line_number", &["editor.gutter.foreground", "editor.fold.foreground"]),
    ("editor.active_line_number", &["editor.active_line.gutter_foreground"]),
    ("editor.active_line.background", &["editor.active_line.background"]),
    ("editor.document_highlight.read_background", &["editor.match_bracket.background"]),
    ("elevated_surface.background", &["panel.elevated.background", "panel.overlay.background", "editor.fold.background"]),
    ("surface.background", &["panel.background", "comms.outer.background"]),
    ("background", &["comms.surface.background"]),
    ("panel.background", &["panel.rail.background"]),
    ("scrollbar.track.background", &["scrollbar.track.background"]),
    ("scrollbar.thumb.background", &["scrollbar.thumb.background"]),
    ("scrollbar.thumb.hover_background", &["scrollbar.thumb.hover"]),
    ("tab.active_background", &["tab.active.background"]),
    ("tab.inactive_background", &["tab.inactive.background"]),
    ("terminal.background", &["terminal.background"]),
    ("terminal.foreground", &["terminal.foreground"]),
    ("terminal.ansi.black", &["terminal.ansi.black"]),
    ("terminal.ansi.red", &["terminal.ansi.red"]),
    ("terminal.ansi.green", &["terminal.ansi.green"]),
    ("terminal.ansi.yellow", &["terminal.ansi.yellow"]),
    ("terminal.ansi.blue", &["terminal.ansi.blue"]),
    ("terminal.ansi.magenta", &["terminal.ansi.magenta"]),
    ("terminal.ansi.cyan", &["terminal.ansi.cyan"]),
    ("terminal.ansi.white", &["terminal.ansi.white"]),
    ("terminal.ansi.bright_black", &["terminal.ansi.bright_black"]),
    ("terminal.ansi.bright_red", &["terminal.ansi.bright_red"]),
    ("terminal.ansi.bright_green", &["terminal.ansi.bright_green"]),
    ("terminal.ansi.bright_yellow", &["terminal.ansi.bright_yellow"]),
    ("terminal.ansi.bright_blue", &["terminal.ansi.bright_blue"]),
    ("terminal.ansi.bright_magenta", &["terminal.ansi.bright_magenta"]),
    ("terminal.ansi.bright_cyan", &["terminal.ansi.bright_cyan"]),
    ("terminal.ansi.bright_white", &["terminal.ansi.bright_white"]),
];

/// Zed syntax scope → Atlas `syntax.*` key. Zed's map is richer than Atlas's
/// twenty keys, so several Zed scopes collapse onto one Atlas key; the first
/// one present wins.
const SYNTAX_MAP: &[(&str, &[&str])] = &[
    ("syntax.comment", &["comment", "comment.doc"]),
    ("syntax.keyword", &["keyword"]),
    ("syntax.string", &["string"]),
    ("syntax.number", &["number"]),
    ("syntax.type", &["type"]),
    ("syntax.function", &["function"]),
    ("syntax.variable", &["variable"]),
    ("syntax.operator", &["operator"]),
    ("syntax.tag", &["tag"]),
    ("syntax.attribute", &["attribute"]),
    ("syntax.constant", &["constant"]),
    ("syntax.regexp", &["string.regex"]),
    ("syntax.escape", &["string.escape"]),
    ("syntax.definition", &["title", "constructor"]),
    ("syntax.property", &["property"]),
    ("syntax.boolean", &["boolean"]),
    ("syntax.null", &["constant.builtin", "constant"]),
    ("syntax.meta", &["preproc", "embedded"]),
    ("syntax.builtin", &["variable.special", "variant"]),
    ("syntax.punctuation", &["punctuation", "punctuation.delimiter"]),
];

/// Zed style keys that exist, are understood, and have nowhere to go.
/// Listed by prefix so the report can say *why* rather than "unknown".
const IGNORED_PREFIXES: &[(&str, &str, &str)] = &[
    ("icon", "icon roles", "Atlas icons take their colour from the text roles"),
    ("players", "collaboration", "Atlas has no multiplayer cursors"),
    ("editor.wrap_guide", "editor furniture", "Atlas's editor draws no wrap guides"),
    ("editor.active_wrap_guide", "editor furniture", "Atlas's editor draws no wrap guides"),
    ("editor.invisible", "editor furniture", "Atlas does not render invisibles"),
    ("editor.subheader", "editor furniture", "Atlas has no editor subheader"),
    ("editor.highlighted_line", "editor furniture", "Atlas highlights only the active line"),
    ("editor.document_highlight.write", "editor furniture", "Atlas has one bracket/occurrence highlight, not a read/write pair"),
    ("status_bar", "app chrome", "Atlas's status bar follows the panel tokens"),
    ("title_bar", "app chrome", "Atlas's title bar follows the panel tokens"),
    ("toolbar", "app chrome", "Atlas's toolbars follow the panel tokens"),
    ("tab_bar", "app chrome", "Atlas's tab strip follows the tab tokens"),
    ("pane", "app chrome", "Atlas has no per-pane border role"),
    ("panel.focused_border", "app chrome", "Atlas has one focus border role"),
    ("drop_target", "app chrome", "Atlas draws drop targets from the primary token"),
    ("link_text", "app chrome", "Atlas links follow text.accent"),
    ("search.match", "app chrome", "Atlas search highlighting follows the selection token"),
    ("success.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("warning.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("error.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("info.background", "status", "Atlas derives the tinted status fill from the status foreground, so there is nothing to set"),
    ("conflict", "vcs", "Atlas shows conflicts through the status tokens"),
    ("renamed", "vcs", "Atlas has no renamed-file colour"),
    ("ignored", "vcs", "Atlas has no ignored-file colour"),
    ("hidden", "vcs", "Atlas has no hidden-file colour"),
    ("unreachable", "vcs", "Atlas has no unreachable-code colour"),
    ("predictive", "editor furniture", "Atlas has no inline-prediction colour"),
    ("hint", "editor furniture", "Atlas has no inlay-hint colour"),
    ("terminal.bright_foreground", "terminal", "Atlas has one terminal foreground"),
    ("terminal.dim_foreground", "terminal", "Atlas has one terminal foreground"),
    ("terminal.ansi.dim", "terminal", "Atlas exposes the 16-colour ANSI set, not Zed's dim ramp"),
];

pub(crate) fn import(value: &Value, options: &ImportOptions) -> Result<Vec<ImportedTheme>, ThemeError> {
    let family = value.get("name").and_then(Value::as_str).unwrap_or("Zed theme");
    let author = value.get("author").and_then(Value::as_str);
    let themes = value
        .get("themes")
        .and_then(Value::as_array)
        .ok_or_else(|| crate::validation(&options.origin, "a Zed theme family needs a `themes` array"))?;
    if themes.is_empty() {
        return Err(crate::validation(&options.origin, "`themes` is empty"));
    }

    let mut out = Vec::with_capacity(themes.len());
    for entry in themes {
        out.push(import_one(entry, family, author, options)?);
    }
    Ok(out)
}

fn import_one(
    entry: &Value,
    family: &str,
    author: Option<&str>,
    options: &ImportOptions,
) -> Result<ImportedTheme, ThemeError> {
    let name = entry.get("name").and_then(Value::as_str).unwrap_or(family).to_string();
    let appearance = match entry.get("appearance").and_then(Value::as_str) {
        Some("light") => "light",
        _ => "dark",
    };
    let style = entry
        .get("style")
        .and_then(Value::as_object)
        .ok_or_else(|| crate::validation(&options.origin, format!("theme \"{name}\" has no `style` object")))?;

    let mut report = ImportReport::new("zed", name.clone(), Fidelity::NearLossless);
    let mut draft = VariantDraft::new(appearance);

    // Players first: `players[0].cursor` is a better `editor.caret` than the
    // editor foreground STYLE_MAP would otherwise leave there, and first writer
    // wins inside a draft.
    map_players(style, &mut draft, &mut report);
    for (source, targets) in STYLE_MAP {
        let Some(value) = string_at(style, source) else { continue };
        for target in *targets {
            draft.map_color_key(target, source, value);
        }
    }
    map_syntax(style, &mut draft, &mut report);
    fill_gaps(&mut draft);

    draft.fill_palette();
    derive_base_tokens(&mut draft, style);
    draft.fill_required_base();

    record_ignored(style, &mut report);
    report.note(
        "Atlas's theme keys were modelled on Zed's roles, so the editor, terminal, syntax and diff colours transfer directly",
    );
    report.note(
        "Zed has no shadcn layer, so all 45 base tokens were derived from the style — check `primary`, `accent` and `card` first if the chrome looks off",
    );

    finish_theme_with_name(vec![draft], report, options, &name, family, author)
}

/// `players[0]` is the local user, so its cursor and selection are the ones the
/// single-user Atlas actually draws.
fn map_players(style: &Map<String, Value>, draft: &mut VariantDraft, report: &mut ImportReport) {
    let Some(first) = style.get("players").and_then(Value::as_array).and_then(|list| list.first()) else {
        return;
    };
    if let Some(cursor) = first.get("cursor").and_then(Value::as_str) {
        draft.map_color_key("editor.caret", "players[0].cursor", cursor);
        draft.map_color_key("terminal.cursor", "players[0].cursor", cursor);
    }
    if let Some(selection) = first.get("selection").and_then(Value::as_str) {
        for target in ["selection.background", "editor.selection.background", "terminal.selection"] {
            draft.map_color_key(target, "players[0].selection", selection);
        }
    }
    let extra = style.get("players").and_then(Value::as_array).map_or(0, Vec::len).saturating_sub(1);
    if extra > 0 {
        report.ignore(
            format!("players[1..{}]", extra + 1),
            "collaboration",
            "Atlas has no multiplayer cursors; only the local player's cursor and selection are used",
        );
    }
}

/// Zed's `syntax` map is `{scope: {color, font_style, font_weight}}`. Only the
/// colour crosses: an Atlas theme key is a colour and nothing else, and the
/// loader rejects a `font_style` outright rather than accept one no consumer
/// reads. So an italicised scope is imported upright, and says so in the
/// dropped list — the alternative is a TOML the loader refuses.
fn map_syntax(style: &Map<String, Value>, draft: &mut VariantDraft, report: &mut ImportReport) {
    let Some(syntax) = style.get("syntax").and_then(Value::as_object) else { return };
    let mut used = std::collections::BTreeSet::new();
    let mut styled = std::collections::BTreeSet::new();
    for (target, scopes) in SYNTAX_MAP {
        for scope in *scopes {
            let Some(entry) = syntax.get(*scope) else { continue };
            let Some(color) = entry.get("color").and_then(Value::as_str) else { continue };
            let has_font_style = entry
                .get("font_style")
                .and_then(Value::as_str)
                .is_some_and(|style| !style.eq_ignore_ascii_case("normal"));
            if draft.map_key(target, &format!("syntax.{scope}"), ThemeKeyValue::Color(color.to_string())) {
                used.insert((*scope).to_string());
                if has_font_style {
                    styled.insert((*scope).to_string());
                }
                break;
            }
        }
    }
    for scope in &styled {
        report.ignore(
            format!("syntax.{scope}.font_style"),
            "font styles",
            "an Atlas theme key carries a colour only; the scope is imported with its colour and no italics",
        );
    }
    let unused = syntax.keys().filter(|scope| !used.contains(*scope)).count();
    if unused > 0 {
        report.ignore(
            format!("syntax.* ({unused} scopes)"),
            "syntax scopes",
            "Atlas has 20 syntax roles; Zed's finer scopes collapse onto them and the surplus is dropped",
        );
    }
}

/// Zed roles Atlas wants but Zed does not name, taken from the nearest thing it
/// does. Kept separate from [`STYLE_MAP`] so a reader can tell "Zed said this"
/// from "Atlas worked this out".
fn fill_gaps(draft: &mut VariantDraft) {
    const GAPS: &[(&str, &str)] = &[
        ("editor.fold.border", "border"),
        ("border.subtle", "border.variant"),
        ("panel.rail.background", "surface.background"),
        ("comms.mention.foreground", "text.accent"),
        ("comms.other_mention.foreground", "text.muted"),
    ];
    for (target, source) in GAPS {
        if draft.has_key(target) {
            continue;
        }
        // The source is itself an Atlas key filled above, so this is a copy
        // inside the draft rather than a second read of the Zed style.
        let mapped = match *source {
            "border" => draft.key_color("border.default"),
            "border.variant" => draft.key_color("border.variant"),
            "surface.background" => draft.key_color("panel.background"),
            "text.accent" => draft.key_color("text.accent"),
            "text.muted" => draft.key_color("text.muted"),
            _ => None,
        }
        .map(str::to_string);
        if let Some(value) = mapped {
            draft.map_color_key(target, source, &value);
        }
    }
}

/// The 46 shadcn base tokens, from Zed roles.
///
/// Every entry here is a judgement, so each is a one-liner rather than a table:
/// `accent` is shadcn's *hover surface* (the audit's "accent collision"), not a
/// brand colour, which is why it comes from `element.hover` and `primary` comes
/// from `text.accent`.
fn derive_base_tokens(draft: &mut VariantDraft, style: &Map<String, Value>) {
    let get = |key: &str| string_at(style, key).map(str::to_string);
    const PAIRS: &[(&str, &str)] = &[
        ("background", "background"),
        ("foreground", "text"),
        ("card", "elevated_surface.background"),
        ("card-foreground", "text"),
        ("popover", "elevated_surface.background"),
        ("popover-foreground", "text"),
        ("primary", "text.accent"),
        ("secondary", "surface.background"),
        ("secondary-foreground", "text.muted"),
        ("muted", "element.background"),
        ("muted-foreground", "text.muted"),
        ("accent", "element.hover"),
        ("accent-foreground", "text"),
        ("destructive", "error"),
        ("border", "border"),
        ("input", "border"),
        ("ring", "border.focused"),
        ("sidebar", "surface.background"),
        ("sidebar-foreground", "text"),
        ("sidebar-primary", "text.accent"),
        ("sidebar-accent", "element.hover"),
        ("sidebar-accent-foreground", "text"),
        ("sidebar-border", "border.variant"),
        ("sidebar-ring", "border.focused"),
        ("chart-1", "terminal.ansi.blue"),
        ("chart-2", "terminal.ansi.green"),
        ("chart-3", "terminal.ansi.yellow"),
        ("chart-4", "terminal.ansi.magenta"),
        ("chart-5", "terminal.ansi.red"),
    ];
    for (token, source) in PAIRS {
        if let Some(value) = get(source) {
            draft.map_base(token, &format!("style.{source}"), &value);
        }
    }
    // The remaining tokens (`primary-foreground`, the fonts, the shadow ramp,
    // `radius`) have no Zed source at all: `fill_required_base` derives them
    // and reports each one.
}

fn record_ignored(style: &Map<String, Value>, report: &mut ImportReport) {
    let mapped: std::collections::BTreeSet<&str> = STYLE_MAP.iter().map(|(key, _)| *key).collect();
    let mut counted: std::collections::BTreeMap<(&str, &str), usize> = std::collections::BTreeMap::new();
    let mut unknown = Vec::new();
    for key in style.keys() {
        if key == "syntax" || mapped.contains(key.as_str()) {
            continue;
        }
        match IGNORED_PREFIXES
            .iter()
            .filter(|(prefix, _, _)| key == prefix || key.starts_with(&format!("{prefix}.")))
            .max_by_key(|(prefix, _, _)| prefix.len())
        {
            Some((_, category, reason)) => *counted.entry((category, reason)).or_default() += 1,
            None => unknown.push(key.clone()),
        }
    }
    for ((category, reason), count) in counted {
        report.ignore(format!("{count} {category} key(s)"), category, reason);
    }
    for key in unknown {
        report.ignore(key, "unmapped zed role", "no Atlas theme key carries this role");
    }
}

fn string_at<'a>(style: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    style.get(key).and_then(Value::as_str)
}

/// A Zed family member carries its own name and the family's author, so it
/// cannot go through the plain `finish_theme` path the other importers use.
fn finish_theme_with_name(
    drafts: Vec<VariantDraft>,
    report: ImportReport,
    options: &ImportOptions,
    name: &str,
    family: &str,
    author: Option<&str>,
) -> Result<ImportedTheme, ThemeError> {
    let scoped = ImportOptions {
        origin: options.origin.clone(),
        id_hint: None,
        name_hint: Some(name.to_string()),
        author_hint: Some(author.unwrap_or(family).to_string()),
        license_hint: options.license_hint.clone(),
    };
    finish_theme(drafts, report, &scoped)
}
