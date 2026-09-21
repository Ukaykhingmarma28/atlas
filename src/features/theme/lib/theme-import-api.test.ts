import { describe, expect, it } from "vitest";
import { themeIdSlug } from "./theme-import-api";

/**
 * `themeIdSlug` labels the import preview with the id Rust will save under, so
 * it has to agree with `atlas_theme::import::slug`. These are the vectors
 * `slugs_a_name_into_a_theme_id` in `crates/atlas-theme/src/import/mod.rs`
 * pins on the Rust side; a change to either must change both.
 */
describe("themeIdSlug", () => {
  it.each([
    ["Rosé Pine Dawn", "rose-pine-dawn"],
    ["  One Dark Pro!! ", "one-dark-pro"],
    ["!!!", ""],
    ["Straße Æther", "strasse-aether"],
    ["Ωmega--Theme_2", "mega-theme-2"],
    ["my-theme", "my-theme"],
  ])("%j -> %j", (input, expected) => {
    expect(themeIdSlug(input)).toBe(expected);
  });
});
