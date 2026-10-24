import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";

/**
 * The file tab's second row, under its tab: the tree's toolbar on the left
 * and the file's breadcrumbs and actions on the right. Both halves take this
 * one height and rule so the row reads as one band.
 */
export const FILE_SURFACE_SUBHEADER_CLASS = "h-control-lg shrink-0 border-b border-border";

/** The file view header's one-icon actions: a tooltip, and `pressed` for a toggle. */
export function FileSurfaceAction(props: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Hint label={props.label}>
      <IconButton
        size="sm"
        icon={props.icon}
        label={props.label}
        disabled={props.disabled ?? false}
        {...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed })}
        onClick={props.onPress}
      />
    </Hint>
  );
}

/** A one-line note under the header: a limit the view is showing, say. */
export function FileSurfaceNotice(props: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-border bg-warning-muted px-3 py-1.5 text-2xs text-warning"
    >
      {props.children}
    </div>
  );
}

export function FileSurfaceLoading() {
  return (
    <div
      role="status"
      aria-label="Loading file"
      className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
    >
      Loading…
    </div>
  );
}

export function FileSurfaceFailure(props: {
  readonly message: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
    >
      <p className="text-destructive">{props.message}</p>
      {props.detail ? (
        <code className="block max-w-full break-all font-mono text-muted-foreground select-all">
          {props.detail}
        </code>
      ) : null}
      {props.action}
    </div>
  );
}
