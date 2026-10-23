// The composer's inline chip: an atom node whose view is a React component.
//
// A chip is self-contained. Its node carries the feature's whole record as
// one attribute (`data`), so undo/redo restores it from history like any
// other node, an in-editor copy/paste carries it in the HTML
// (`data-composer-chip`), and the feature reads it straight off the document.
// Its text form is whatever the feature's `toText` says — the clipboard's
// plain-text flavour and the composer's serializer both use it.
//
// Performance: ProseMirror only updates a node view when it is handed a NEW
// node object, which happens when that chip itself changes — typing beside it
// reuses the node and touches nothing. The feature's view is memoized on the
// record and the selected bit on top of that, so a transaction that does reach
// it without changing either is free.

import { memo, type ComponentType, type ReactNode } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";

import { cn } from "@/lib/utils";
import { FileIcon } from "@/features/icon-theme/components/file-icon";

/** What a feature's chip view is given. */
export interface ComposerChipViewProps<T> {
  data: T;
  selected: boolean;
}

export interface ComposerChipSpec<T> {
  /** The node's schema name; unique per editor. */
  name: string;
  /** The text this chip stands for. */
  toText: (data: T) => string;
  view: ComponentType<ComposerChipViewProps<T>>;
}

/** A Tiptap node for one kind of chip. */
export function createChipNode<T>(spec: ComposerChipSpec<T>) {
  const View = memo(spec.view) as ComponentType<ComposerChipViewProps<T>>;
  function ChipNodeView({ node, selected }: ReactNodeViewProps) {
    return <View data={node.attrs.data as T} selected={selected} />;
  }
  ChipNodeView.displayName = `ComposerChip(${spec.name})`;

  return Node.create({
    name: spec.name,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        data: {
          default: null,
          parseHTML: (el) => {
            try {
              return JSON.parse(el.getAttribute("data-chip") ?? "null");
            } catch {
              return null;
            }
          },
          renderHTML: (attrs) => ({ "data-chip": JSON.stringify(attrs.data) }),
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: `span[data-composer-chip="${spec.name}"]`,
          // No readable record, no chip: let the span parse as its text.
          getAttrs: (el) => (el.getAttribute("data-chip") ? null : false),
        },
      ];
    },

    renderHTML({ node, HTMLAttributes }) {
      return [
        "span",
        mergeAttributes({ "data-composer-chip": spec.name }, HTMLAttributes),
        spec.toText(node.attrs.data as T),
      ];
    },

    renderText({ node }) {
      return spec.toText(node.attrs.data as T);
    },

    addNodeView() {
      return ReactNodeViewRenderer(ChipNodeView, { as: "span" });
    },
  });
}

/** The record a chip node carries. */
export function chipData<T>(node: PMNode): T {
  return node.attrs.data as T;
}

/**
 * The chip's look, for a feature's view to fill in: an icon, a label, and the
 * selection ring when the chip is node-selected. Must be the view's root —
 * `NodeViewWrapper` is what Tiptap mounts.
 */
export function ComposerChip({
  icon,
  label,
  selected,
  title,
  className,
  children,
  ...rest
}: {
  icon: ReactNode;
  label: ReactNode;
  selected: boolean;
  title?: string;
  className?: string;
  children?: ReactNode;
  [data: `data-${string}`]: string | undefined;
} & Pick<React.HTMLAttributes<HTMLSpanElement>, "onMouseEnter" | "onMouseLeave">) {
  return (
    <NodeViewWrapper
      as="span"
      className={cn("atlas-mention-chip", selected && "atlas-mention-chip--selected", className)}
      title={title}
      contentEditable={false}
      {...rest}
    >
      <span className="atlas-mention-chip__icon">{icon}</span>
      <span className="atlas-mention-chip__label">{label}</span>
      {children}
    </NodeViewWrapper>
  );
}

/** A file's or folder's icon under the active icon theme — the same icon the
 *  explorer row for that path shows. */
export function ComposerPathIcon({ path, folder = false }: { path: string; folder?: boolean }) {
  return <FileIcon path={path} kind={folder ? "folder" : "file"} size={12} />;
}
