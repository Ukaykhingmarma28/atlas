import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Line wrapping for an editor view, live-toggleable through a compartment so
 * flipping the `wordWrap` setting reconfigures the view in place: the buffer,
 * the undo history and the scroll position survive.
 */
export const wrapCompartment = new Compartment();

export function wordWrapExtension(wrap: boolean): Extension {
  return wrapCompartment.of(wrap ? EditorView.lineWrapping : []);
}

export function setWordWrap(view: EditorView, wrap: boolean): void {
  view.dispatch({ effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []) });
}
