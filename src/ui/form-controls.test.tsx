// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Segmented } from "./segmented";
import { Select } from "./select";
import { Switch } from "./switch";

afterEach(cleanup);

describe("Switch", () => {
  it("reports the next state", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Wrap" />);
    const control = screen.getByRole("switch", { name: "Wrap" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("is mixed to assistive tech, and a click turns it on", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked mixed onCheckedChange={onCheckedChange} aria-label="Wrap" />);
    const control = screen.getByRole("switch", { name: "Wrap" });
    expect(control.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("ignores clicks while disabled", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked disabled onCheckedChange={onCheckedChange} aria-label="Wrap" />);
    fireEvent.click(screen.getByRole("switch", { name: "Wrap" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

const MODES = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const;

describe("Select", () => {
  it("shows the selected option's label, not its value", () => {
    render(<Select value="dark" onValueChange={() => {}} options={MODES} aria-label="Mode" />);
    const trigger = screen.getByRole("combobox", { name: "Mode" });
    expect(trigger.textContent).toContain("Dark");
  });

  it("shows the placeholder instead of the value when given one", () => {
    render(
      <Select
        value="dark"
        onValueChange={() => {}}
        options={MODES}
        placeholder="Mixed"
        aria-label="Mode"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Mode" }).textContent).toContain("Mixed");
  });
});

describe("Segmented", () => {
  it("is a radio group with one tab stop, and arrows move the selection", () => {
    const onValueChange = vi.fn();
    render(
      <Segmented value="system" onValueChange={onValueChange} options={MODES} aria-label="Mode" />,
    );
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenLastCalledWith("dark");
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(onValueChange).toHaveBeenLastCalledWith("light");
    fireEvent.click(radios[2]);
    expect(onValueChange).toHaveBeenLastCalledWith("light");
  });

  it("does not re-select the active option", () => {
    const onValueChange = vi.fn();
    render(
      <Segmented value="system" onValueChange={onValueChange} options={MODES} aria-label="Mode" />,
    );
    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
