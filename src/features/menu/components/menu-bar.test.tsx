// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runMenuItem } = vi.hoisted(() => ({ runMenuItem: vi.fn(() => true) }));
vi.mock("../lib/run-menu-item", () => ({ runMenuItem }));

import { MenuBar } from "./menu-bar";

afterEach(cleanup);

describe("MenuBar", () => {
  it("shows the shared menus without the macOS-only ones", () => {
    render(<MenuBar />);
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual(["Atlas", "File", "Edit", "View", "Window", "Help"]);
  });

  it("runs the clicked item by its id", async () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send Feedback…" }));
    expect(runMenuItem).toHaveBeenCalledWith("help.feedback");
  });
});
