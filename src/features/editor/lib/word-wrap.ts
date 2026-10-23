import { Compartment, type EditorState, type Extension } from "@codemirror/state";
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

/** Whether this state's view wraps lines. False when the compartment isn't
 *  installed at all (an editor that never offered wrapping). */
export function isWrapping(state: EditorState): boolean {
  return wrapCompartment.get(state) === EditorView.lineWrapping;
}

export function setWordWrap(view: EditorView, wrap: boolean): void {
  view.dispatch({ effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []) });
}
