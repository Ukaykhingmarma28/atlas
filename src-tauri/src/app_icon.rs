//! The Dock icon, from the persisted `appIcon` setting.
//!
//! The bundle ships the dark Liquid Glass icon (`icons/AtlasIcon.icon`,
//! compiled into Assets.car). macOS has no alternate-app-icon API, so the
//! light variant is applied at runtime through `NSApplication
//! setApplicationIconImage:` — that covers the Dock and the app switcher while
//! Atlas runs, and Finder/Launchpad keep the bundle icon. Rewriting the icon on
//! the bundle itself would break its code signature, and the auto-updater would
//! replace it anyway.
//!
//! `Dark` resets to the bundle icon by setting `nil`, rather than loading a
//! copy of it, so the Liquid Glass rendering stays the system's own.
//!
//! The light image is `icons/AtlasLight.icns`, a bundled resource rendered
//! from the Icon Composer source by `scripts/render-app-icons.sh`.

use crate::state::atlas_config::AppIcon;
use tauri::AppHandle;

/// Apply `icon` as the Dock icon. Safe to call from any thread and on every
/// settings commit — AppKit work is dispatched to the main thread, and
/// re-applying the current icon is harmless. No-op off macOS.
pub fn apply(app: &AppHandle, icon: AppIcon) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        let path = match icon {
            AppIcon::Dark => None,
            AppIcon::Light => match app.path().resource_dir() {
                Ok(dir) => Some(dir.join("icons/AtlasLight.icns")),
                Err(e) => {
                    tracing::warn!(target: "atlas::app_icon", "no resource dir: {e}");
                    return;
                }
            },
        };
        let _ = app.run_on_main_thread(move || set_application_icon(path.as_deref()));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, icon);
    }
}

/// `-[NSApplication setApplicationIconImage:]` with the image at `path`, or
/// `nil` (the bundle icon) when `path` is `None`. Main thread only.
#[cfg(target_os = "macos")]
fn set_application_icon(path: Option<&std::path::Path>) {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use std::ffi::CString;

    autoreleasepool(|_| unsafe {
        let (Some(app_class), Some(image_class), Some(str_class)) = (
            AnyClass::get(c"NSApplication"),
            AnyClass::get(c"NSImage"),
            AnyClass::get(c"NSString"),
        ) else {
            return;
        };
        let ns_app: *mut AnyObject = msg_send![app_class, sharedApplication];
        if ns_app.is_null() {
            return;
        }

        let mut image: *mut AnyObject = std::ptr::null_mut();
        if let Some(path) = path {
            let Ok(c_path) = CString::new(path.to_string_lossy().as_bytes()) else {
                return;
            };
            let ns_path: *mut AnyObject = msg_send![str_class, stringWithUTF8String: c_path.as_ptr()];
            let allocated: *mut AnyObject = msg_send![image_class, alloc];
            image = msg_send![allocated, initWithContentsOfFile: ns_path];
            if image.is_null() {
                tracing::warn!(target: "atlas::app_icon", "could not load {}", path.display());
                return;
            }
            // `init…` returns +1; the app retains what it keeps.
            let _: *mut AnyObject = msg_send![image, autorelease];
        }
        let _: () = msg_send![ns_app, setApplicationIconImage: image];
    });
}
