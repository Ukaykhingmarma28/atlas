//! A whole third-party icon theme, from `.vsix` bytes to a rendered glyph.
//!
//! The unit tests cover each stage on its own. What they cannot cover is the
//! join: a `.vsix` unpacks to `extension/`, whose `package.json` names a theme
//! document by a path relative to itself, whose `iconPath`s and `fonts[].src`
//! are in turn relative to *that*. Three relative bases in a row is where this
//! goes wrong, and every failure looks the same from the UI — blank icons.
//!
//! The fixture is font-based on purpose. Seti is the theme most people install
//! after Material, it is the reason the format has a `fonts` array at all, and
//! a webview can only render its glyphs if the WOFF comes back inlined.

use std::io::Write;
use std::path::Path;

use atlas_icon_theme::{
    icon_assets, icon_fonts, load_from_directory, resolve_icons, vsix, Appearance, IconKind,
    IconRequest, IconThemeError, ResolvedIcon,
};

/// The bytes of a `.vsix` holding a small Seti-shaped icon theme.
fn seti_like_vsix() -> Vec<u8> {
    let package_json = r#"{
      "name": "pretend-seti",
      "displayName": "Pretend Seti",
      "publisher": "Atlas Tests",
      "license": "MIT",
      "contributes": {
        "iconThemes": [
          { "id": "pretend-seti", "label": "Pretend Seti", "path": "./icons/seti.json" }
        ]
      }
    }"#;
    // Note the bases: the document sits in `icons/`, so `./seti.woff` is
    // `icons/seti.woff` and `./../images/logo.png` is `images/logo.png`.
    let document = r##"{
      // Published as JSONC, comments and all.
      "fonts": [{
        "id": "seti",
        "src": [{ "path": "./seti.woff", "format": "woff" }],
        "weight": "normal", "style": "normal", "size": "115%"
      }],
      "iconDefinitions": {
        "_default": { "fontCharacter": "\\E001", "fontColor": "#9ca3af", "fontId": "seti" },
        "_ts":      { "fontCharacter": "\\E002", "fontColor": "#519aba", "fontId": "seti" },
        "_ts_light":{ "fontCharacter": "\\E002", "fontColor": "#1f6f9c", "fontId": "seti" },
        "_png":     { "iconPath": "./../images/logo.png" },
      },
      "file": "_default",
      "fileExtensions": { "ts": "_ts", "png": "_png" },
      "light": { "fileExtensions": { "ts": "_ts_light" } },
      "hidesExplorerArrows": true
    }"##;

    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in [
            ("extension/package.json", package_json.as_bytes()),
            ("extension/icons/seti.json", document.as_bytes()),
            // Not a real WOFF; the crate only moves the bytes.
            ("extension/icons/seti.woff", b"wOFF-pretend".as_slice()),
            ("extension/images/logo.png", b"\x89PNG\r\n\x1a\n-pretend".as_slice()),
            // Dropped on unpack: an extension host Atlas never runs.
            ("extension/dist/extension.js", b"module.exports={}".as_slice()),
            ("extension.vsixmanifest", b"<PackageManifest/>".as_slice()),
        ] {
            writer.start_file(name, options).expect("start_file");
            writer.write_all(body).expect("write");
        }
        writer.finish().expect("finish");
    }
    buffer
}

fn unpack(into: &Path) {
    vsix::unpack_extension(&seti_like_vsix(), into).expect("the fixture unpacks");
}

#[test]
fn a_vsix_unpacks_into_a_loadable_theme() {
    let dir = tempfile::tempdir().expect("tempdir");
    unpack(dir.path());
    let theme = load_from_directory("atlas-tests.pretend-seti", dir.path()).expect("loads");

    assert_eq!(theme.summary.name, "Pretend Seti", "the contribution's label wins");
    assert_eq!(theme.summary.author, "Atlas Tests");
    assert_eq!(theme.summary.license, "MIT");
    assert!(!theme.summary.built_in);
    assert!(theme.summary.hides_explorer_arrows);
    assert_eq!(theme.summary.warnings, Vec::new());
}

#[test]
fn a_glyph_icon_arrives_with_its_character_and_colour_inline() {
    let dir = tempfile::tempdir().expect("tempdir");
    unpack(dir.path());
    let theme = load_from_directory("pretend-seti", dir.path()).expect("loads");

    let requests = vec![
        IconRequest { path: "/p/a.ts".into(), kind: IconKind::File, language_id: None },
        IconRequest { path: "/p/a.unknown".into(), kind: IconKind::File, language_id: None },
    ];
    let resolved = resolve_icons(&theme, &requests, Appearance::Dark);

    let ResolvedIcon::Glyph { definition, character, color, .. } =
        resolved[0].clone().expect("the .ts file resolves")
    else {
        panic!("expected a glyph");
    };
    assert_eq!(definition, "_ts");
    assert_eq!(character, "\u{E002}", "decoded from the theme's `\\E002` escape");
    assert_eq!(color.as_deref(), Some("#519aba"));

    let ResolvedIcon::Glyph { definition, .. } = resolved[1].clone().expect("falls back") else {
        panic!("expected a glyph");
    };
    assert_eq!(definition, "_default");
}

#[test]
fn the_light_section_of_a_directory_theme_is_honoured() {
    let dir = tempfile::tempdir().expect("tempdir");
    unpack(dir.path());
    let theme = load_from_directory("pretend-seti", dir.path()).expect("loads");
    let requests =
        vec![IconRequest { path: "/p/a.ts".into(), kind: IconKind::File, language_id: None }];

    let dark = resolve_icons(&theme, &requests, Appearance::Dark);
    let light = resolve_icons(&theme, &requests, Appearance::Light);
    let name = |icon: &Option<ResolvedIcon>| match icon.clone().expect("resolves") {
        ResolvedIcon::Glyph { definition, .. } | ResolvedIcon::Image { definition } => definition,
    };
    assert_eq!(name(&dark[0]), "_ts");
    assert_eq!(name(&light[0]), "_ts_light");
}

#[test]
fn the_theme_font_comes_back_inlined_as_a_data_url() {
    let dir = tempfile::tempdir().expect("tempdir");
    unpack(dir.path());
    let theme = load_from_directory("pretend-seti", dir.path()).expect("loads");

    let fonts = icon_fonts(&theme);
    assert_eq!(fonts.len(), 1);
    assert_eq!(fonts[0].id, "seti");
    assert_eq!(fonts[0].size.as_deref(), Some("115%"));
    assert_eq!(fonts[0].src.len(), 1, "the font file was found through two relative hops");
    assert_eq!(fonts[0].src[0].format, "woff");
    assert_eq!(
        fonts[0].src[0].url, "data:font/woff;base64,d09GRi1wcmV0ZW5k",
        "the webview needs the bytes; it has no file access"
    );
}

#[test]
fn a_binary_icon_comes_back_as_a_data_url_and_an_svg_as_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    unpack(dir.path());
    // An SVG alongside the PNG, so both branches of the asset reader run.
    std::fs::write(dir.path().join("images/mark.svg"), "<svg id=\"mark\"/>").expect("write");
    let document_path = dir.path().join("icons/seti.json");
    let document = std::fs::read_to_string(&document_path).expect("read");
    std::fs::write(
        &document_path,
        document.replace(
            r#""_png":     { "iconPath": "./../images/logo.png" },"#,
            r#""_png": { "iconPath": "./../images/logo.png" },
             "_svg": { "iconPath": "./../images/mark.svg" },"#,
        ),
    )
    .expect("write");

    let theme = load_from_directory("pretend-seti", dir.path()).expect("loads");
    let assets = icon_assets(&theme, &["_png".to_string(), "_svg".to_string(), "_ts".to_string()]);

    assert_eq!(assets.len(), 2, "a glyph definition has no asset to fetch");
    match assets.get("_png").expect("png") {
        atlas_icon_theme::IconAsset::DataUrl { url } => {
            assert!(url.starts_with("data:image/png;base64,"), "{url}");
        }
        other => panic!("expected a data URL, got {other:?}"),
    }
    match assets.get("_svg").expect("svg") {
        atlas_icon_theme::IconAsset::Svg { source } => {
            assert_eq!(
                source, "<svg id=\"mark\"/>",
                "SVG is handed over as source so `currentColor` can follow the colour theme"
            );
        }
        other => panic!("expected inline SVG, got {other:?}"),
    }
}

#[test]
fn a_directory_that_is_not_an_icon_theme_is_refused_by_name() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join("package.json"),
        r#"{ "name": "a-colour-theme", "contributes": { "themes": [] } }"#,
    )
    .expect("write");
    let error = load_from_directory("a-colour-theme", dir.path()).unwrap_err();
    assert!(
        matches!(&error, IconThemeError::Parse { message, .. }
                 if message.contains("contributes.iconThemes")),
        "{error}"
    );
}

#[test]
fn a_missing_package_json_names_the_file_it_wanted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let error = load_from_directory("empty", dir.path()).unwrap_err();
    assert!(error.to_string().contains("package.json"), "{error}");
}
