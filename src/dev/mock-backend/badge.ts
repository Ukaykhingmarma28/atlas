// A small fixed badge showing which scenario is active and how many commands
// the screen called that nothing answered. Plain DOM on purpose: it must work
// before React mounts and must not depend on any app store.

export function mountBadge(scenario: string, unmocked: () => string[]): () => void {
  const el = document.createElement("div");
  el.setAttribute("data-mock-badge", "");
  Object.assign(el.style, {
    position: "fixed",
    right: "8px",
    bottom: "8px",
    zIndex: "100000",
    font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#fff",
    background: "rgba(120, 60, 200, 0.85)",
    borderRadius: "6px",
    padding: "4px 8px",
    maxWidth: "360px",
    maxHeight: "50vh",
    overflow: "auto",
    cursor: "pointer",
    whiteSpace: "pre",
  } satisfies Partial<CSSStyleDeclaration>);

  let open = false;
  const render = () => {
    const list = unmocked();
    const head = `mock · ${scenario} · ${list.length} unmocked`;
    el.textContent = open && list.length ? `${head}\n${list.sort().join("\n")}` : head;
    el.style.background = list.length ? "rgba(190, 70, 40, 0.9)" : "rgba(120, 60, 200, 0.85)";
  };
  el.addEventListener("click", () => {
    open = !open;
    render();
  });

  const attach = () => {
    document.body.appendChild(el);
    render();
  };
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      render();
    });
  };
}
