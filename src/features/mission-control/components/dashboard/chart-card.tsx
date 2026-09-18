import { cn } from "@/lib/utils";

/** Titled card wrapper for a chart, on the AMOLED surface. */
export function ChartCard({
  title,
  subtitle,
  right,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      // Promote to its own compositor layer so scrolling the dashboard moves
      // the layer instead of repainting the SVG chart each frame (WKWebView).
      style={{ transform: "translateZ(0)" }}
      className={cn(
        "rounded-lg border border-[var(--border)] bg-[var(--card)] flex flex-col min-w-0",
        className,
      )}
    >
      <div className="flex items-center justify-between px-3.5 pt-3 pb-1 shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--foreground)] truncate">{title}</div>
          {subtitle && (
            <div className="text-2xs text-[var(--muted-foreground)] truncate">{subtitle}</div>
          )}
        </div>
        {right}
      </div>
      <div className={cn("flex-1 min-h-0 px-2 pb-2", bodyClassName)}>{children}</div>
    </div>
  );
}
