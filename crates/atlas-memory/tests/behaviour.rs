//! Behaviour lock for the session-extraction and embedding-provider modules
//! (`session.rs`, `embedding.rs`). The graph and consolidation-gate sections
//! went with those modules in #89.
//!
//! These pin what the code does today. Most of it is contract: on-disk
//! spellings, filenames and the extraction wire format that shipped installs
//! already depend on. A few assertions pin behaviour that is wrong, and each of
//! those is marked `KNOWN BUG` so nobody reads it as intended. Fixing one of
//! them is welcome, but it has to land as a deliberate edit to this file in the
//! same change, not as a side effect that turns a test red.

use atlas_memory::session::{
    extraction_prompt, parse_extraction_output, persist_memories, ExtractedMemory, MemoryCategory,
};

// ─── MemoryCategory ──────────────────────────────────────────────────────────

/// `label()` is written into the memdir markdown, so these five strings are
/// on-disk data.
#[test]
fn memory_category_labels_are_stable() {
    assert_eq!(MemoryCategory::UserPreference.label(), "preference");
    assert_eq!(MemoryCategory::ProjectFact.label(), "project");
    assert_eq!(MemoryCategory::CodePattern.label(), "pattern");
    assert_eq!(MemoryCategory::Decision.label(), "decision");
    assert_eq!(MemoryCategory::Constraint.label(), "constraint");
}

#[test]
fn memory_category_from_str_accepts_every_alias() {
    for s in ["preference", "userpreference", "user_preference", "PREFERENCE"] {
        assert!(
            matches!(MemoryCategory::parse(s), Some(MemoryCategory::UserPreference)),
            "{s}"
        );
    }
    for s in ["project", "projectfact", "project_fact"] {
        assert!(
            matches!(MemoryCategory::parse(s), Some(MemoryCategory::ProjectFact)),
            "{s}"
        );
    }
    for s in ["pattern", "codepattern", "code_pattern"] {
        assert!(
            matches!(MemoryCategory::parse(s), Some(MemoryCategory::CodePattern)),
            "{s}"
        );
    }
    assert!(matches!(
        MemoryCategory::parse("decision"),
        Some(MemoryCategory::Decision)
    ));
    assert!(matches!(
        MemoryCategory::parse("constraint"),
        Some(MemoryCategory::Constraint)
    ));
    assert!(MemoryCategory::parse("bogus").is_none());
}

// ─── parse_extraction_output ─────────────────────────────────────────────────

#[test]
fn parse_extraction_happy_path() {
    let out = "\
Some preamble the model emitted.
MEMORY: preference | 9 | User prefers Rust over Go
MEMORY: project | 7 | The app is a Tauri desktop shell
trailing chatter
";
    let mems = parse_extraction_output(out);
    assert_eq!(mems.len(), 2);
    assert_eq!(mems[0].content, "User prefers Rust over Go");
    assert!((mems[0].confidence - 0.9).abs() < 1e-6, "{}", mems[0].confidence);
    assert_eq!(mems[0].category.label(), "preference");
    assert_eq!(mems[1].content, "The app is a Tauri desktop shell");
    assert!((mems[1].confidence - 0.7).abs() < 1e-6);
    assert_eq!(mems[1].category.label(), "project");
}

#[test]
fn parse_extraction_rejects_malformed_lines() {
    // Missing prefix, too few fields, unknown category, unparsable confidence,
    // and an empty fact are all dropped — silently, one line at a time.
    let out = "\
preference | 9 | no MEMORY prefix
MEMORY: preference | 9
MEMORY: nonsense | 9 | unknown category
MEMORY: preference | high | non-numeric confidence
MEMORY: preference | 9 |
MEMORY: decision | 5 | this one is fine
";
    let mems = parse_extraction_output(out);
    assert_eq!(mems.len(), 1, "{mems:?}");
    assert_eq!(mems[0].content, "this one is fine");
}

#[test]
fn parse_extraction_clamps_confidence_above_ten() {
    let mems = parse_extraction_output("MEMORY: decision | 25 | over-confident model");
    assert_eq!(mems.len(), 1);
    assert!((mems[0].confidence - 1.0).abs() < 1e-6, "{}", mems[0].confidence);
}

/// A negative confidence is rejected outright (the `confidence < 0.0` guard runs
/// after the divide-by-ten, before the clamp), so the line is dropped rather
/// than being clamped to zero and kept.
#[test]
fn parse_extraction_drops_negative_confidence() {
    assert!(parse_extraction_output("MEMORY: decision | -5 | negative confidence").is_empty());
    // Zero is still a valid confidence and survives.
    let zero = parse_extraction_output("MEMORY: decision | 0 | zero confidence");
    assert_eq!(zero.len(), 1, "{zero:?}");
    assert_eq!(zero[0].confidence, 0.0);
}

#[test]
fn parse_extraction_keeps_pipes_inside_the_fact() {
    // splitn(3, '|') means only the first two pipes are delimiters.
    let mems = parse_extraction_output("MEMORY: project | 8 | uses a | b | c pipeline");
    assert_eq!(mems.len(), 1);
    assert_eq!(mems[0].content, "uses a | b | c pipeline");
}

#[test]
fn parse_extraction_tolerates_indentation_and_empty_input() {
    let mems = parse_extraction_output("    MEMORY: decision | 5 | indented line");
    assert_eq!(mems.len(), 1, "leading whitespace is trimmed first");
    assert!(parse_extraction_output("").is_empty());
    assert!(parse_extraction_output("no memories here").is_empty());
}

#[test]
fn extraction_prompt_states_the_wire_format() {
    let p = extraction_prompt();
    // The parser above only understands this one line shape, so the prompt has
    // to keep asking for it verbatim.
    assert!(p.contains("MEMORY: <category> | <confidence 0-10> | <fact>"), "{p}");
    for cat in ["preference", "project", "pattern", "decision", "constraint"] {
        assert!(p.contains(cat), "prompt omits category {cat}");
    }
}

// ─── persist_memories ────────────────────────────────────────────────────────

fn mem(cat: MemoryCategory, content: &str, confidence: f32) -> ExtractedMemory {
    ExtractedMemory {
        content: content.to_string(),
        category: cat,
        confidence,
    }
}

/// The exact rendered line is parsed back by the record store's legacy memdir
/// import, so its shape is a contract between the two modules.
#[test]
fn persist_renders_the_expected_entry_line() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("extracted").join("s1.md");

    persist_memories(&[mem(MemoryCategory::Decision, "chose usearch", 0.85)], &target).unwrap();

    let body = std::fs::read_to_string(&target).unwrap();
    assert!(
        body.contains("- **[decision]** chose usearch *(confidence: 85%)*"),
        "{body}"
    );
    assert!(body.contains("## Auto-extracted memories"), "{body}");
    assert!(body.contains("### Session memories — "), "{body}");
    // Confidence is rendered with no decimal places.
    assert!(!body.contains("85.0%"), "{body}");
}

#[test]
fn persist_creates_parent_directories() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("deep").join("nested").join("s.md");
    persist_memories(&[mem(MemoryCategory::ProjectFact, "fact", 0.5)], &target).unwrap();
    assert!(target.exists());
}

#[test]
fn persist_empty_slice_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("s.md");
    persist_memories(&[], &target).unwrap();
    assert!(!target.exists(), "no file should be created for zero memories");
}

#[test]
fn persist_appends_into_the_same_date_block() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("s.md");

    persist_memories(&[mem(MemoryCategory::Decision, "first", 0.9)], &target).unwrap();
    persist_memories(&[mem(MemoryCategory::Decision, "second", 0.8)], &target).unwrap();

    let body = std::fs::read_to_string(&target).unwrap();
    assert!(body.contains("first"), "{body}");
    assert!(body.contains("second"), "{body}");
    // Same UTC day → one section header and one date header, not two.
    assert_eq!(body.matches("## Auto-extracted memories").count(), 1, "{body}");
    assert_eq!(body.matches("### Session memories — ").count(), 1, "{body}");
}

#[test]
fn persist_preserves_unrelated_existing_content() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("s.md");
    std::fs::write(&target, "# Hand-written notes\n\nkeep me\n").unwrap();

    persist_memories(&[mem(MemoryCategory::Constraint, "no network", 0.6)], &target).unwrap();

    let body = std::fs::read_to_string(&target).unwrap();
    assert!(body.contains("# Hand-written notes"), "{body}");
    assert!(body.contains("keep me"), "{body}");
    assert!(body.contains("- **[constraint]** no network"), "{body}");
}

// ─── EmbeddingProvider seam ──────────────────────────────────────────────────

/// `MiniLmProvider` implements this trait; changing its method set or
/// signatures breaks the provider.
#[test]
fn embedding_provider_trait_shape_is_unchanged() {
    use atlas_memory::embedding::{EmbeddingError, EmbeddingProvider};

    struct Fake;

    #[async_trait::async_trait]
    impl EmbeddingProvider for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        fn dimensions(&self) -> usize {
            3
        }
        async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
            Ok(texts.iter().map(|_| vec![0.1, 0.2, 0.3]).collect())
        }
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    rt.block_on(async {
        let f = Fake;
        assert_eq!(f.name(), "fake");
        assert_eq!(f.dimensions(), 3);

        // The default `embed` must delegate to `embed_batch`.
        let one = f.embed("hello").await.unwrap();
        assert_eq!(one, vec![0.1, 0.2, 0.3]);

        let many = f
            .embed_batch(&["a".to_string(), "b".to_string()])
            .await
            .unwrap();
        assert_eq!(many.len(), 2);
    });
}
