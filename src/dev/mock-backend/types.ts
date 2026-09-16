// Shapes shared by the dev-only mock backend. See `install.ts`.

/** Args exactly as the frontend passed them to `invoke(cmd, args)`. */
// oxlint-disable-next-line typescript/no-explicit-any -- a fake backend answers every command; args are per-command.
export type MockArgs = Record<string, any>;

/** One fake command. Return the value Rust would return; throw to make it fail. */
export type MockHandler = (args: MockArgs) => unknown;

export type MockHandlers = Record<string, MockHandler>;

export interface Scenario {
  /** URL key: `?scenario=<name>`. */
  name: string;
  /** One line for the scenario index. */
  description: string;
  /** Answers that override the base handlers for this scenario. */
  commands?: MockHandlers;
  /** Runs synchronously at install, before any app code. Seed fake state here. */
  init?: () => void;
  /**
   * Runs once the app has mounted (after `atlas:app-ready`). Use it to open the
   * right tab, or to fire events with `emit()` so the screen shows live changes.
   */
  setup?: () => void | Promise<void>;
  /** Named triggers, callable from the console as `__atlasMock.actions.<name>()`. */
  actions?: Record<string, () => void | Promise<void>>;
}
