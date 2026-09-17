# macOS window corners and edge line: is `.atlas-window-border` needed?

*Research note, 2026-09-17, branch `0.3.3`. Measured on macOS 27.0 (build 26A428), Apple Silicon, Retina (scale 2.0), system appearance Dark, Swift 6.4, macOS 27.0 SDK. Tauri 2.11.1 / tauri-runtime-wry 2.11.1 / tao 0.35.2 / wry 0.55.1 (versions from `Cargo.lock`).*

## 1. The question and the verdict

`index.html:192-199` draws a fixed, click-through overlay with `border: 1px solid rgba(255,255,255,0.18); border-radius: 10px`, and `index.html:241` renders it on every page load. The comment above it (`index.html:173-191`) says three things:

1. macOS rounds the window and clips Atlas's content to that shape.
2. Atlas had a light edge only along the top, from the title bar, while Zed and Chrome have one on all four sides.
3. The window corner radius is "~10px on Sonoma/Sequoia".

**Verdict, for the build Atlas ships today (macOS 27 SDK) on macOS 27:**

- **Claim 1 is right.** The window server clips the whole window, including a `WKWebView` that fills it, to the rounded shape.
- **Claim 2 is wrong here.** The window server draws its own light edge on all four sides, in both appearances.
- **Claim 3 is out of date.** The radius is 16 pt with a continuous (squircle-style) curve, not 10.

So the overlay does not add a missing edge. It **draws a second edge on top of the system one**: the edge is 25/255 grey without the overlay and 67/255 with it, so the overlay makes it almost three times as bright. And because a 10 px circular arc sits inside a 16 pt continuous corner, **the system clips the curved part of the overlay away completely**. That leaves straight lines that stop short of each corner, which is the "faded/missing corner" the comment was trying to avoid. In plain Chrome (`bun run dev`) nothing clips the page, so the same CSS shows up as a visible rounded rectangle inside a square viewport.

**Recommendation: delete the overlay** (§7).

## 2. How Atlas's window is built

- `src-tauri/tauri.conf.json` sets `decorations: true`, `transparent: false`, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `backgroundColor: [0,0,0,255]`. No `shadow` key is set, so the default shadow stays on.
- tao builds the `NSWindow` with style mask `Closable | Miniaturizable | Resizable | Titled` whenever `decorations` is true (`tao-0.35.2/src/platform_impl/macos/window.rs:216-228`). It adds `FullSizeContentView` when asked (`:242-244`), calls `setTitlebarAppearsTransparent(true)` / `setTitleVisibility(Hidden)` (`:266-271`), and calls `setHasShadow(false)` only when `has_shadow` is false (`:328-330`, default `true` at `:122`). `setOpaque(false)` is called only for `transparent` windows (`:544-546`). For a background color it calls `setBackgroundColor` (`:548-560`).
- Tauri maps `TitleBarStyle::Overlay` to `with_titlebar_transparent(true)` plus `with_fullsize_content_view(true)` (`tauri-runtime-wry-2.11.1/src/lib.rs:1206-1209`, and again for runtime changes at `:3658-3661`).
- wry turns off the WKWebView background through the private `drawsBackground` KVC key (`wry-0.55.1/src/wkwebview/mod.rs:374-382`) and adds the webview as a plain subview of the content view (`:666`, `:705`). No corner radius or `masksToBounds` is set anywhere in wry (grep for `cornerRadius|masksToBounds` finds nothing). Any rounding therefore comes from AppKit or the window server, not from Tauri.
- Atlas's own Rust code sets only the background color (`src-tauri/src/lib.rs:118-131`) and calls `performZoom:` (`src-tauri/src/commands/window.rs`). It does not touch the style mask, shadow or corners.
- With `FullSizeContentView`, "the window's contentView consumes the full size of the window", and the style is "respected only for windows with a title bar" ([NSWindow.StyleMask.fullSizeContentView](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/fullsizecontentview)). `titlebarAppearsTransparent` means "the title bar does not draw its background" ([NSWindow.titlebarAppearsTransparent](https://developer.apple.com/documentation/appkit/nswindow/titlebarappearstransparent)). So on the non-title-bar sides, only the webview's pixels and whatever the system adds on top are visible.
- The installed `/Applications/Atlas.app` has `LC_BUILD_VERSION minos 11.0 sdk 27.0` (`otool -l`), and `LSMinimumSystemVersion` is 11.0. Apple's `UIDesignRequiresCompatibility` key is the switch that keeps the pre-26 look, and "the system ignores this key when you build for … macOS 27 or later" ([UIDesignRequiresCompatibility](https://developer.apple.com/documentation/bundleresources/information-property-list/uidesignrequirescompatibility)). **Atlas therefore always gets the current system window design.**

### History of the overlay

`git log -S atlas-window-border` finds a single commit: `d2d36163` "kb update" (2026-05-26), which added both the CSS and the `<div>` and has not changed them since. That commit's own comment contradicts itself. One paragraph says "Paint only left / right / bottom" because the title bar "already paints the top hairline… stacking our own on top of it doubles the line". The CSS below it paints all four sides, and `z-index: 99999` places it above Atlas's own title bar. The window setup has changed twice since then: an `NSVisualEffectView` (HudWindow) vibrancy layer was used and then removed in `16e4a574` "removed window blur for mission control" (2026-06-03, see the tombstone comment at `src-tauri/src/lib.rs:124-131`). The overlay's assumptions were never checked again after either change. `16e4a574` also committed a reference screenshot, `border.png` (a grey vertical line between two adjacent windows), and it was later deleted.

## 3. Method

Apple does not document the window corner radius or the edge line in prose, so the answers below come from two sources: Apple's docs and WWDC sessions (primary) and direct measurement on this machine. The measurement probe is a throwaway Swift/AppKit program. It is not committed and lives in the session scratchpad. It opens windows configured the way tao configures Atlas's window: `[.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]`, transparent title bar, hidden title, black `backgroundColor`, and a `WKWebView` with `drawsBackground = false` loading `<body style="background:#000">`, which matches wry. It then captures each window with `/usr/sbin/screencapture -l <windowNumber>`, both with `-o` (window only, no system shadow) and without it (window plus the system shadow as composited). It reads the pixels with CoreGraphics. Variants:

| variant | what differs |
|---|---|
| `atlas-dark` | the Atlas configuration, `darkAqua` appearance |
| `atlas-dark-overlay` | same, with the page also drawing the exact `.atlas-window-border` CSS |
| `atlas-light` | Atlas configuration, `aqua` appearance |
| `atlas-clear`, `atlas-clear-nonopaque` | `backgroundColor = .clear` (and `isOpaque = false`), as in the May 2026 config (`backgroundColor [0,0,0,0]`) |
| `plain-titled-dark` | ordinary titled window, no full-size content |
| `titlebar-only`, `toolbar-unified`, `toolbar-compact`, `toolbar-expanded` | `NSToolbar` with one item and each `toolbarStyle`, plus a subview at the bottom-left corner whose `cornerConfiguration` is `.uniformCorners(radius: .containerConcentric)`, to read `effectiveCornerRadii` |

A second check captured a region of the real screen (`screencapture -R`) across the left edge of a live window, to confirm the edge is really on screen and not an artifact of window capture.

Nothing was measured on macOS 26 or on 11–15, and this machine cannot run them. Statements about those versions come from Apple's WWDC material where it exists and are otherwise labelled **secondary**.

## 4. Findings

### 4.1 The window server clips content, including a full-bleed WKWebView, to the rounded corners

- In every `-o` capture, including the WKWebView variants with a full-size content view and a transparent title bar, the corner pixels are transparent even though the page paints opaque black to every edge. This held for all variants (probe output: `radius px: top-left 35 bottom-left 35` for the opaque windows, 31 for the clear-background ones, where only the anti-aliased outer row differs). **Measured.**
- Apple states the same behaviour for the new design: "These larger corners … can also clip content that sits close to the edge of the window." Apple also provides `NSView.LayoutRegion` with corner avoidance so content can stay clear of the corner ([WWDC25 "Build an AppKit app with the new design", 14:18–14:40](https://developer.apple.com/videos/play/wwdc2025/310/?time=858); [NSView.LayoutRegion](https://developer.apple.com/documentation/appkit/nsview/layoutregion)). **Primary.**
- WebKit is not involved. wry adds no clipping (§2), and the clipped shape is identical with and without a webview (`plain-titled-dark`, `titlebar-only` have no webview). **Measured.**

**Answer to Q1: yes.** On macOS 27, a titled `NSWindow`, including one with `fullSizeContentView` and an overlay title bar, has its whole content clipped to the rounded window shape by the system. Apple's own WWDC25 wording confirms this for macOS 26. For 11–15 this was not measured. The overlay's original comment assumed the same behaviour, and no primary source says otherwise.

### 4.2 The system draws its own edge, on all four sides, over the content

Pixel values at the middle of each edge, from the capture that includes the system shadow (device pixels, outermost first):

| variant | left edge | bottom edge | top edge |
|---|---|---|---|
| `atlas-dark` | `25,25,25` ×2, then black | same | same |
| `atlas-dark-overlay` | **`67,67,67`** ×2, then black | same | same |
| `atlas-light` (window `aqua`) | `25,25,25` ×1, then black | same | same |
| `plain-titled-dark` | `25,25,25` ×2 | same | `59,60,60` ×2 over the `37,38,38` title bar |
| `atlas-clear`, `atlas-clear-nonopaque` | `20,20,20` ×2, `4,4,4`, then black | same | same |

- **The edge is not in the app's pixels.** The `-o` captures of the same windows show pure black `0,0,0` in the outer pixels of `atlas-dark`, and `46,46,46` in `atlas-dark-overlay`, which is exactly `rgba(255,255,255,0.18)` over black. So the grey band is added by the window server when it composites the window, on top of whatever the app drew. The app cannot paint over it or replace it. Anything the page draws there is added to it: 25 (system) + 46 (overlay) combine to 67. **Measured.**
- **It is on the real screen.** A live screen grab across the left edge of a `titlebar-only` window shows the wallpaper darkening under the shadow (`124 → 111`), then three device pixels of `19–20` grey, then the black content. **Measured.**
- **It runs along the sides and the bottom, not only the title bar.** The only side-specific difference is at the top of a window with a visible title bar, where the edge sits on the title bar's lighter background. **Measured.**
- It is still there with a clear, non-opaque window background (the May 2026 configuration), slightly dimmer. That capture was taken while the window was not key, which probably explains the difference; the probe did not isolate this. **Measured.**
- Apple publishes no prose spec for this edge. The HIG only says "a macOS window consists of a frame and a body area" ([HIG: Windows](https://developer.apple.com/design/human-interface-guidelines/windows)). [`hasShadow`](https://developer.apple.com/documentation/appkit/nswindow/hasshadow) and [`invalidateShadow()`](https://developer.apple.com/documentation/appkit/nswindow/invalidateshadow()) ("recomputed based on the current window shape") are the documented controls closest to it. That the edge belongs to the shadow is **an inference, not verified**: the edge is missing from exactly the captures that omit the shadow (`-o`). The probe did not test `hasShadow = false`.

**Answer to Q2: yes, on macOS 27, in both dark and light appearance, on all four sides.** Atlas's window gets this edge for free. Tauri keeps the shadow on by default, and nothing in Atlas turns it off. Whether macOS 11–15 drew the same edge for a full-size-content window was **not measured**. The May 2026 comment says Atlas lacked one on the sides at the time. That observation was made with a different window setup (clear background, and later vibrancy) and on an unrecorded OS version, so it cannot be checked now.

### 4.3 Corner radius: 16 pt continuous on macOS 27, independent of toolbar style

- `NSView.effectiveCornerRadii` on a `.containerConcentric` view placed flush in the window's bottom-left corner returns **16.0 for all four corners** in `titlebar-only`, `toolbar-unified`, `toolbar-compact` and `toolbar-expanded` alike. A view at zero inset takes the container's radius: "The closer the view is to the container's corner, the more its radius should match" ([WWDC26 "Modernize your AppKit app", 15:41](https://developer.apple.com/videos/play/wwdc2026/289/?time=941)). **Measured + primary.**
- The pixel profile of the clipped corner agrees. The coverage-weighted inset per device-pixel row, counted up from the bottom edge, is `36.19 24.88 20.91 18.24 16.22 14.49 13.10 11.73 10.62`, against a circular 16 pt arc's `26.4 22.3 19.6 17.5 15.6 14.1 12.7 11.4 10.3`, and it is identical in all four toolbar variants and in the Atlas webview variants. The curve departs from the edge 24 pt away, about 1.5 × the 16 pt radius, which is the signature of a continuous corner rather than a circular one. Apple's corner-radius type carries "a corner curve" as well as radii ([NSViewCornerRadii](https://developer.apple.com/documentation/appkit/nsviewcornerradii)). A 10 pt circle predicts `15.6 12.4 10.3 8.7 …`, far from what the system draws. **Measured.**
- **macOS 26:** Apple says "windows now have a softer, more generous corner radius, which varies based on the style of window. Windows with toolbars now use a larger radius … scaling to match the size of the toolbar. Titlebar-only windows retain a smaller corner radius" ([WWDC25-310, 14:00](https://developer.apple.com/videos/play/wwdc2025/310/?time=840)). **Primary**, but Apple publishes no point values. The figures that circulate (about 26 pt with a toolbar on Tahoe) come from **secondary** sources only: [lapcatsoftware, "macOS Tahoe windows have different corner radiuses"](https://lapcatsoftware.com/articles/2026/3/1.html), [Michael Tsai, "Tahoe Window Corners"](https://mjtsai.com/blog/2025/10/16/tahoe-window-corners/), [zed-industries/zed discussion #38233](https://github.com/zed-industries/zed/discussions/38233).
- **macOS 27:** the probe found no radius difference between toolbar styles. The macOS 27 release notes contain no entry about window corners ([macOS 27 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes), searched for corner/radius/window). So this is **measured behaviour on 27.0 (26A428) without a documented rationale**. The probe's toolbars had a single small item, so a toolbar with large items was not tested.
- **Sonoma/Sequoia (14/15) "~10 pt":** no Apple source was found. It is a **secondary** figure (the zed discussion above; the Atlas comment itself) and was not measured here.
- **Can an app read it?** On macOS 27 and later, yes, indirectly: put a view at the window corner with `cornerConfiguration = .uniformCorners(radius: .containerConcentric)` and read [`effectiveCornerRadii`](https://developer.apple.com/documentation/appkit/nsview/effectivecornerradii). That property, [`NSViewCornerConfiguration`](https://developer.apple.com/documentation/appkit/nsviewcornerconfiguration) and [`NSViewCornerRadius.containerConcentric`](https://developer.apple.com/documentation/appkit/nsviewcornerradius/containerconcentric) are all marked *macOS 27.0*. The `NSWindow` and `NSView` symbol lists contain nothing corner-related before that, so **on macOS 26 and earlier there is no public API** for the window radius (an absence found by searching the docs, not a documented statement). `NSView.LayoutRegion(cornerAdaptation:)` lets layout avoid the corner on 26 without knowing the number.

**Answer to Q3:** on macOS 26 the radius depends on the window's style (primary), with no published numbers. On macOS 27 (measured) it is 16 pt with a continuous curve for Atlas's window and for every toolbar style tested. Before 26 it is reportedly 10 pt (secondary). It can be read on 27+ only.

### 4.4 What a hard-coded `border-radius: 10px` does

Bottom-left corner of `atlas-dark-overlay` without the system shadow (`#` = overlay grey, `.` = content, space = clipped by the system; one character is one device pixel, bottom 20 rows shown):

```
 #..............................................................
  ..............................................................
   .............................................................
    ............................................................
     ...........................................................
      ..........................................................
        ........................................................
          ......................................................
            ....................................................
               .................................................
                  ..............................................
                     ...........................................
                         #######################################
                                   #############################
```

- **Mismatched curve: the corner disappears.** The CSS arc (10 px radius) lies entirely outside the system's 16 pt continuous clip, so the whole curved part is cut off. The vertical line ends about 25 device px above the bottom, and the horizontal line starts about 25 device px in. The border reads as four separate straight strokes with gaps at the corners. **Measured.**
- **Doubled edge.** Along every straight edge, including the top, the overlay's 46 grey adds to the system's 25, giving 67. That is the "doubles the line and looks darker/brighter" problem the original comment raised for the top, and it now applies to all four sides. **Measured.**
- **Plain Chrome (`bun run dev`).** A normal browser viewport is a rectangle that is not clipped, so the overlay draws in full: a 1 px rounded rectangle with visible 10 px curved corners, inset inside the tab. That is the rounded line seen in the mock-backend browser. It is simply the CSS drawing what it says, and nothing native is involved. The mock backend is a no-op inside Tauri (`src/dev/mock-backend/install.ts:110`, keyed on `globalThis.isTauri`), so the browser is the only place the full shape is visible.
- Matching the radius would not fix this. CSS `border-radius` is a circular arc and the system corner is continuous, so even a 16 px CSS radius would drift away from the clip near the corner (compare the 16 pt circle with the measured profile in §4.3). The doubled edge would also remain.

## 5. Answers in brief

| # | question | answer | confidence |
|---|---|---|---|
| 1 | Does macOS clip a titled window's content, including a full-bleed WKWebView with full-size content / overlay title bar, to the rounded corners? | Yes | High on 27 (measured); high on 26 (Apple WWDC25); unverified on 11–15 |
| 2 | Does macOS draw its own edge, and where? | Yes, on all four sides, composited over the content, in dark and light | High on 27 (measured, incl. real-screen grab); not known for 11–15; the claim that it is part of the shadow is an inference |
| 3 | Radius on Sonoma/Sequoia vs 26+; fixed? readable? | 14/15 ≈10 pt (secondary only); 26 varies by style (primary, no numbers); 27: 16 pt continuous, same for all toolbar styles (measured); readable only on 27+ via `effectiveCornerRadii` | High for 27; medium for 26; low for 14/15 numbers |
| 4 | Effect of hard-coded 10 px | Curve fully clipped (corners vanish), straight edges doubled (25 → 67), full rounded rectangle visible in Chrome | High (measured) |

## 6. What this does not cover

- macOS 11–15 and 26 were not run, and Atlas still declares `LSMinimumSystemVersion 11.0`. The edge on those versions for this exact window configuration is unverified.
- The shipped Atlas app itself was not captured (it was not running). The probe reproduces tao's and wry's calls line for line (§2), and the webview is the same WebKit.
- Displays at scale 1.0, Increase Contrast, and Reduce Transparency were not tested. Increase Contrast plausibly changes the system edge.

## 7. Recommendation

**Delete `.atlas-window-border`** (the CSS block and its comment at `index.html:173-199`, and the `<div>` at `index.html:241`). Nothing else references it (repo-wide grep).

- *For:* on the SDK Atlas builds with, the system already draws the edge on all four sides and clips the corners itself. The overlay only brightens the edge to 67 on every side, breaks each corner into a gap, and shows as a stray rounded rectangle in the browser dev mode.
- *Against:* if macOS 11–15 really draws no side edge for this window configuration, those users lose a faint line. That is cosmetic, unverified, and the overlay would still clip wrongly there if the radius was not exactly 10 pt.

Alternatives considered:

- **Restrict it to Tauri** (e.g. add the class only when `globalThis.isTauri`). This removes the Chrome artifact but keeps both real defects in the app, so it is not worth doing.
- **Drive the radius from native code** (read `effectiveCornerRadii` on 27+ and pass it to a CSS variable). This fixes the number but not the curve shape (circular vs continuous) or the doubled edge, and costs a Rust/objc2 bridge. Not recommended.
- **If a stronger edge is ever wanted as a design choice,** it should be an explicit design decision checked on macOS 26 and 27 in `bun run dev:app`, not a replacement for a system edge that already exists. Even then it should paint only where the system does not, which on 27 is nowhere.

Check after deleting it: `bun run dev:app`, then look at the window's side and bottom edges and all four corners against a light and a dark wallpaper, in dark and light appearance. The edge should be the thin system line and the corners unbroken.
