import { toast } from "sonner";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { LAYOUT_TEMPLATES, type LayoutTemplate } from "@/features/layout/templates";
import { LayoutThumbnail } from "@/features/layout/components/layout-thumbnail";

/** Settings → Layouts: the same predefined templates the ⌘⌥L switcher offers,
 *  applied with a click. */
export function LayoutsSettings() {
  const switcherHint = useActionShortcut("nav.layoutSwitcher")?.label ?? "⌘⌥L";
  const apply = (t: LayoutTemplate) => {
    useLayoutStore.getState().actions.applyLayoutTemplate(t);
    toast.success(`Applied “${t.name}” layout`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Layouts</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Rearrange panels and tabs into a ready-made project. Press{" "}
          <kbd className="px-1 py-0.5 rounded bg-card border border-border font-mono text-3xs">
            {switcherHint}
          </kbd>{" "}
          anytime to switch layouts.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {LAYOUT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => apply(t)}
            className={cn(
              "text-left rounded-xl border border-border bg-card p-3",
              "hover:border-[var(--atlas-border-strong)] transition-colors outline-none",
            )}
          >
            <LayoutThumbnail template={t} />
            <div className="mt-2 text-sm font-medium text-foreground">{t.name}</div>
            <div className="text-2xs text-muted-foreground leading-snug">{t.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
