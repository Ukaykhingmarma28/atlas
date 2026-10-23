import { describe, expect, it } from "vitest";
import {
  fileChipLabel,
  inlineCodeFileTarget,
  inlineCodePathCandidate,
  linkFileTarget,
  resolveInProject,
  splitPosition,
} from "./file-links";

const ROOT = "/Users/dev/acme-app";

describe("inline code that names a project file", () => {
  it.each([
    ["src/lib/api.ts", `${ROOT}/src/lib/api.ts`, undefined],
    ["./src/lib/api.ts", `${ROOT}/src/lib/api.ts`, undefined],
    ["src/lib/api.ts:42", `${ROOT}/src/lib/api.ts`, 42],
    ["src/lib/api.ts:42:7", `${ROOT}/src/lib/api.ts`, 42],
    ["src/lib/api.ts#L10", `${ROOT}/src/lib/api.ts`, 10],
    ["api.ts:12", `${ROOT}/api.ts`, 12],
    [`${ROOT}/README.md`, `${ROOT}/README.md`, undefined],
    ["docker/Dockerfile", `${ROOT}/docker/Dockerfile`, undefined],
    ["src/a/../b/c.tsx", `${ROOT}/src/b/c.tsx`, undefined],
  ])("%s", (code, path, line) => {
    const target = inlineCodeFileTarget(code, ROOT);
    expect(target?.path).toBe(path);
    expect(target?.line).toBe(line);
  });

  it.each([
    ["a URL", "https://example.com/a.ts"],
    ["a scheme-less host", "github.com/acme/app.ts"],
    ["a version", "1.2.3"],
    ["a versioned name", "packages/react-19.0.1"],
    ["e.g.", "e.g."],
    ["i.e.", "i.e."],
    ["a glob", "src/**/*.ts"],
    ["a brace glob", "src/{a,b}.ts"],
    ["a bare word", "useState"],
    ["a bare file name", "package.json"],
    ["a sentence", "run src/a.ts now"],
    ["a folder", "src/lib/"],
    ["no extension", "src/lib/api"],
    ["a path outside the project", "/etc/hosts"],
    ["a relative path that climbs out", "../outside/x.ts"],
    ["a sibling project", "/Users/dev/acme-app-2/a.ts"],
    ["a host and port", "localhost:3000"],
    ["a member access", "foo.bar"],
  ])("leaves %s as code", (_name, code) => {
    expect(inlineCodeFileTarget(code, ROOT)).toBeNull();
  });

  it("takes ~/ against the home the root sits in", () => {
    expect(inlineCodeFileTarget("~/acme-app/src/a.ts", ROOT)?.path).toBe(`${ROOT}/src/a.ts`);
    expect(inlineCodeFileTarget("~/.zshrc.d/x.sh", ROOT)).toBeNull();
  });

  it("is shape alone, before any root", () => {
    expect(inlineCodePathCandidate("src/a.ts:3")).toEqual({ path: "src/a.ts", line: 3 });
    expect(inlineCodePathCandidate("src/a.ts")).toEqual({ path: "src/a.ts" });
  });
});

describe("link destinations that name a project file", () => {
  it.each([
    ["src/lib/utils.ts", `${ROOT}/src/lib/utils.ts`, false],
    ["src/lib/utils.ts#L3", `${ROOT}/src/lib/utils.ts`, false],
    ["./docs/", `${ROOT}/docs`, true],
    [`file://${ROOT}/src/a.ts`, `${ROOT}/src/a.ts`, false],
    ["<src/My%20File.ts>", `${ROOT}/src/My File.ts`, false],
  ])("%s", (href, path, folder) => {
    const target = linkFileTarget(href, ROOT);
    expect(target?.path).toBe(path);
    expect(target?.folder).toBe(folder);
  });

  it.each([
    "https://example.com/a.ts",
    "mailto:dev@acme.dev",
    "#section",
    "//cdn.example.com/a.js",
    "/etc/hosts",
    "docs/page?x=1",
    "github.com/acme/app",
  ])("leaves %s alone", (href) => {
    expect(linkFileTarget(href, ROOT)).toBeNull();
  });
});

describe("helpers", () => {
  it("splits a position off either way it is written", () => {
    expect(splitPosition("a.ts:3:4")).toEqual({ path: "a.ts", line: 3, column: 4 });
    expect(splitPosition("a.ts#L9C2")).toEqual({ path: "a.ts", line: 9, column: 2 });
    expect(splitPosition("a.ts")).toEqual({ path: "a.ts" });
  });

  it("keeps a resolved path inside the root, or gives null", () => {
    expect(resolveInProject("src/../a.ts", ROOT)).toBe(`${ROOT}/a.ts`);
    expect(resolveInProject("../../x", ROOT)).toBeNull();
    expect(resolveInProject("a.ts", "/")).toBeNull();
  });

  it("labels a chip by base name and line", () => {
    expect(fileChipLabel({ path: `${ROOT}/src/a.ts`, line: 4, folder: false })).toBe("a.ts:4");
    expect(fileChipLabel({ path: `${ROOT}/src/a.ts`, folder: false })).toBe("a.ts");
  });
});
