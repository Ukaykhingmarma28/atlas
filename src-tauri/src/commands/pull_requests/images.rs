//! Images in pull-request bodies and comments, fetched through `gh`.
//!
//! The webview's CSP keeps `img-src` closed, and an attachment in a private
//! repository needs the user's credential anyway, so an image is fetched
//! here — signed by `gh` — and handed to the page as bytes. Only GitHub's
//! own image hosts are fetched: `gh api` follows any absolute URL, and
//! anything else in a comment would otherwise turn Atlas into a fetcher for
//! whoever wrote it (and send the credential along).

use std::collections::{HashMap, VecDeque};
use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use parking_lot::Mutex;

use super::gh::Gh;
use super::model::{PrError, PrImage};

const IMAGE_TIMEOUT: Duration = Duration::from_secs(30);
/// One image past this is refused; a screenshot is a few hundred kilobytes.
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// What the cache holds in all before it forgets the oldest.
const CACHE_BYTES: usize = 48 * 1024 * 1024;

/// Whether `raw` names an image on one of GitHub's image hosts. HTTPS, the
/// exact host, no credentials and no port; on github.com itself only the
/// attachment path, which is where an uploaded image lives.
pub(crate) fn is_allowed_image_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some("github.com") => url.path().starts_with("/user-attachments/assets/"),
        Some(
            "user-images.githubusercontent.com"
            | "private-user-images.githubusercontent.com"
            | "camo.githubusercontent.com"
            | "avatars.githubusercontent.com",
        ) => true,
        _ => false,
    }
}

#[derive(Default)]
struct ImageCache {
    entries: HashMap<String, PrImage>,
    order: VecDeque<String>,
    bytes: usize,
}

impl ImageCache {
    fn get(&mut self, key: &str) -> Option<PrImage> {
        let image = self.entries.get(key)?.clone();
        self.order.retain(|k| k != key);
        self.order.push_back(key.to_string());
        Some(image)
    }

    fn put(&mut self, key: String, image: PrImage) {
        if let Some(old) = self.entries.remove(&key) {
            self.bytes -= old.data.len();
            self.order.retain(|k| k != &key);
        }
        self.bytes += image.data.len();
        self.entries.insert(key.clone(), image);
        self.order.push_back(key);
        while self.bytes > CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(old) = self.entries.remove(&oldest) {
                self.bytes -= old.data.len();
            }
        }
    }
}

static CACHE: LazyLock<Mutex<ImageCache>> = LazyLock::new(|| Mutex::new(ImageCache::default()));

/// The image's media type, if it is one. SVG is refused: it is a document
/// that can carry script, not a picture.
fn image_content_type(raw: Option<&str>) -> Option<String> {
    let media = raw?.split(';').next()?.trim().to_ascii_lowercase();
    (media.starts_with("image/") && media != "image/svg+xml").then_some(media)
}

/// Fetch one image, from the cache when it is there. `cwd` picks the `gh`
/// host and account, as every other read does.
pub(crate) async fn fetch(cwd: &str, url: &str) -> Result<PrImage, PrError> {
    if !is_allowed_image_url(url) {
        return Err(PrError::invalid("Only GitHub's own images are shown."));
    }
    if let Some(image) = CACHE.lock().get(url) {
        return Ok(image);
    }
    let response = Gh::new(cwd).fetch_url(url, IMAGE_TIMEOUT).await?;
    let content_type = image_content_type(response.header("content-type"))
        .ok_or_else(|| PrError::invalid("That link is not an image."))?;
    if response.body.len() > MAX_IMAGE_BYTES {
        return Err(PrError::invalid("That image is too large to show."));
    }
    let image = PrImage {
        content_type,
        data: base64::engine::general_purpose::STANDARD.encode(&response.body),
    };
    CACHE.lock().put(url.to_string(), image.clone());
    Ok(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_github_image_hosts_are_allowed() {
        for allowed in [
            "https://github.com/user-attachments/assets/0f3c-uuid",
            "https://user-images.githubusercontent.com/1/2.png",
            "https://private-user-images.githubusercontent.com/1/2.png?jwt=x",
            "https://camo.githubusercontent.com/abc/def",
            "https://avatars.githubusercontent.com/u/1?v=4",
        ] {
            assert!(is_allowed_image_url(allowed), "{allowed}");
        }
        for refused in [
            "http://user-images.githubusercontent.com/1/2.png",
            "https://github.com/cli/cli",
            "https://github.com/user-attachments/../settings",
            "https://example.com/a.png",
            "https://user-images.githubusercontent.com.evil.test/a.png",
            "https://evil.test/?https://camo.githubusercontent.com/",
            "https://me@camo.githubusercontent.com/a",
            "https://camo.githubusercontent.com:8443/a",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(!is_allowed_image_url(refused), "{refused}");
        }
    }

    #[test]
    fn only_raster_images_are_accepted() {
        assert_eq!(
            image_content_type(Some("image/png")).as_deref(),
            Some("image/png")
        );
        assert_eq!(
            image_content_type(Some("Image/JPEG; charset=binary")).as_deref(),
            Some("image/jpeg")
        );
        assert_eq!(image_content_type(Some("image/svg+xml")), None);
        assert_eq!(image_content_type(Some("text/html")), None);
        assert_eq!(image_content_type(None), None);
    }

    #[test]
    fn the_cache_forgets_the_oldest_past_its_budget() {
        let mut cache = ImageCache::default();
        let big = "x".repeat(CACHE_BYTES / 2 + 1);
        let image = |data: &str| PrImage {
            content_type: "image/png".into(),
            data: data.into(),
        };
        cache.put("a".into(), image(&big));
        cache.put("b".into(), image(&big));
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
        assert!(cache.bytes <= CACHE_BYTES);
    }
}
