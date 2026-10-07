//! The code index as memory's evidence resolver (memory plan M3, ADR-0018):
//! cited files are read from disk as `FileResolver` does, and a cited symbol
//! is relocated through the symbol index when its lines moved. Without an
//! open code index it is exactly a `FileResolver`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_memory::citation::{FileResolver, Read, Resolver};

use super::CodeIndexRegistry;

/// How a scope-relative path is spelled inside the code index.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Translate {
    /// The index root is the scope root.
    Same,
    /// The index root is below the scope root: strip this prefix (`sub/`).
    Strip(String),
    /// The index root is above the scope root: add this prefix (`sub/`).
    Prepend(String),
}

pub struct CodeIndexResolver {
    files: FileResolver,
    index: Option<Arc<atlas_codeindex::CodeIndex>>,
    translate: Translate,
}

fn canonical(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// `sub` as a `/`-separated prefix with a trailing `/` (empty for none).
fn prefix(sub: &Path) -> String {
    let s = sub.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        s
    } else {
        format!("{}/", s.trim_end_matches('/'))
    }
}

impl CodeIndexResolver {
    /// The resolver for memories of the scope at `scope_root`: the open code
    /// index covering it, if any (never opens one).
    pub fn for_scope(registry: &CodeIndexRegistry, scope_root: &Path) -> Self {
        let index = registry.root_for(scope_root).map(|p| p.index.clone());
        Self::with_index(scope_root, index)
    }

    pub(crate) fn with_index(
        scope_root: &Path,
        index: Option<Arc<atlas_codeindex::CodeIndex>>,
    ) -> Self {
        let scope = canonical(scope_root);
        let translate = match &index {
            None => Translate::Same,
            Some(i) => {
                let root = canonical(i.root());
                if let Ok(sub) = root.strip_prefix(&scope) {
                    match prefix(sub) {
                        p if p.is_empty() => Translate::Same,
                        p => Translate::Strip(p),
                    }
                } else if let Ok(sub) = scope.strip_prefix(&root) {
                    Translate::Prepend(prefix(sub))
                } else {
                    Translate::Same
                }
            }
        };
        Self {
            files: FileResolver::new(scope_root),
            index,
            translate,
        }
    }

    /// `rel` (scope-relative) as the index spells it; `None` when the file
    /// is outside the index.
    fn in_index(&self, rel: &str) -> Option<String> {
        match &self.translate {
            Translate::Same => Some(rel.to_string()),
            Translate::Strip(p) => rel.strip_prefix(p.as_str()).map(str::to_string),
            Translate::Prepend(p) => Some(format!("{p}{rel}")),
        }
    }
}

impl Resolver for CodeIndexResolver {
    fn read(&self, rel: &str) -> Read {
        self.files.read(rel)
    }

    fn stamp(&self, rel: &str) -> Option<(u64, i128)> {
        self.files.stamp(rel)
    }

    fn symbol_span(&self, rel: &str, symbol: &str) -> Option<(u32, u32)> {
        let index = self.index.as_ref()?;
        let in_index = self.in_index(rel)?;
        let (hits, _) = index
            .find_symbol(&atlas_codeindex::SymbolQuery {
                query: symbol.to_string(),
                path_prefix: Some(in_index.clone()),
                limit: 20,
                ..Default::default()
            })
            .ok()?;
        hits.iter()
            .find(|h| h.rel == in_index && h.qualified_name == symbol)
            .or_else(|| hits.iter().find(|h| h.rel == in_index && h.name == symbol))
            .map(|h| (h.start_line, h.end_line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_memory::citation::{cite, validate, Validity};

    #[test]
    fn a_symbol_that_moved_is_found_by_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("src/lib.rs");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "pub fn ttl() -> u32 {\n    15\n}\n").unwrap();
        let index = Arc::new(atlas_codeindex::CodeIndex::open(dir.path()).unwrap());
        index
            .full_build(&atlas_search::CancelToken::new(), &|_| {})
            .unwrap();
        let r = CodeIndexResolver::with_index(dir.path(), Some(index.clone()));
        let c = cite(&r, "src/lib.rs", 1, 3, Some("ttl".into())).unwrap();
        // Prepend a function: the cited one moves down three lines.
        std::fs::write(
            &file,
            "pub fn a() {\n}\n\npub fn ttl() -> u32 {\n    15\n}\n",
        )
        .unwrap();
        index.update_paths(std::slice::from_ref(&file)).unwrap();
        assert_eq!(r.symbol_span("src/lib.rs", "ttl"), Some((4, 6)));
        let (v, now) = validate(&c, &r);
        assert_eq!(v, Validity::Moved);
        assert_eq!((now.start_line, now.end_line), (4, 6));
    }

    #[test]
    fn a_scope_inside_or_around_the_index_root_translates_paths() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("app");
        std::fs::create_dir_all(&sub).unwrap();
        // The index at the repository root, memory's scope a subdirectory.
        let index = Arc::new(atlas_codeindex::CodeIndex::open(dir.path()).unwrap());
        let r = CodeIndexResolver::with_index(&sub, Some(index));
        assert_eq!(r.in_index("src/x.rs").as_deref(), Some("app/src/x.rs"));
        // The index at a subdirectory, memory's scope the repository.
        let inner = Arc::new(atlas_codeindex::CodeIndex::open(&sub).unwrap());
        let r = CodeIndexResolver::with_index(dir.path(), Some(inner));
        assert_eq!(r.in_index("app/src/x.rs").as_deref(), Some("src/x.rs"));
        assert_eq!(r.in_index("other/y.rs"), None);
    }
}
