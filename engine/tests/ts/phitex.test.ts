import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Builder, BuildError, OUTLINE_TRACE } from "../../src/core/build.ts";
import { loadProject, readCompiler, writeCompiler, writeSettings } from "../../src/core/config.ts";
import { Fixture } from "./helpers.ts";

const posix = process.platform !== "win32";
// A stand-in for PhiTeX's command line: it records where each build ran, and
// writes the outputs a build writes, SyncTeX naming its folder absolutely.
// Like PhiTeX, it leaves a PDF whose bytes did not change as it is, cannot
// create the folder of an included file's .aux, and reads the contents file
// an earlier build left.
const PHITEX = (runs: string) => `#!/bin/sh
case "$1" in
  --version) echo "phitex 9.9.9"; exit 0 ;;
  clean) echo "clean $PWD" >> "${runs}"; rm -rf build; exit 0 ;;
esac
echo "build $PWD" >> "${runs}"
echo "$*" >> "${runs}.args"
mkdir -p build
printf 'SyncTeX Version:1\\nInput:1:%s/./main.tex\\n' "$PWD" | gzip > build/main.synctex.gz
if grep -q FATAL main.tex; then echo '!  ==> Fatal error occurred, no output PDF file produced!' > build/main.log; exit 1; fi
if grep -q NOPDF main.tex; then echo "error: can't write build/main.pdf" >&2; exit 1; fi
{ echo '%PDF-1.5'; cat main.tex sections/*.tex; } > build/next.pdf
if cmp -s build/next.pdf build/main.pdf; then rm build/next.pdf; else mv build/next.pdf build/main.pdf; fi
if grep -q 'include{chapters/one}' main.tex; then printf '%s\\n' '\\relax' > build/chapters/one.aux || exit 1; fi
if grep -q CORRUPT build/main.toc 2>/dev/null; then printf 'build/main.toc:1: Undefined control sequence.\\n' > build/main.log; exit 1; fi
printf '%s\\n' '\\contentsline' > build/main.toc
if grep -q BROKEN main.tex; then printf '! Undefined control sequence.\\nl.3 BROKEN\\n\\n' > build/main.log; exit 1; fi
echo 'Output written on build/main.pdf (1 page).' > build/main.log
`;

let f: Fixture, runs: string, previous: { PATH?: string; PAPILOT_DATA?: string };
beforeEach(() => {
  f = new Fixture();
  const bin = path.join(f.base, "bin");
  runs = path.join(f.base, "runs");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "phitex"), PHITEX(runs), { mode: 0o755 });
  // latexmk must not run while PhiTeX is chosen.
  fs.writeFileSync(path.join(bin, "latexmk"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  previous = { PATH: process.env.PATH, PAPILOT_DATA: process.env.PAPILOT_DATA };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.PAPILOT_DATA = path.join(f.base, "data");
  writeCompiler("phitex");
});
afterEach(async () => {
  for (const [name, value] of Object.entries(previous))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await f.close();
});
const builds = () => fs.readFileSync(runs, "utf8").trim().split("\n");
const commit = (file: string, text: string) => {
  f.write(file, text);
  f.repo.run(["add", "-A"]);
  f.repo.run(["commit", "-qm", "edit"]);
};

it("uses latexmk unless PhiTeX is chosen, and for LuaLaTeX", () => {
  expect(loadProject(f.root).compiler).toBe("phitex");
  writeSettings(f.root, { engine: "lualatex" });
  expect(loadProject(f.root).compiler).toBe("latexmk");
  writeSettings(f.root, {});
  writeCompiler("latexmk");
  expect(loadProject(f.root).compiler).toBe("latexmk");
  fs.writeFileSync(path.join(process.env.PAPILOT_DATA!, "compiler.json"), '{"compiler":"tectonic"}');
  expect(readCompiler()).toBe("latexmk");
  expect(() => writeCompiler("tectonic" as never)).toThrow("The compiler must be one of latexmk, phitex.");
  delete process.env.PAPILOT_DATA;
  expect(readCompiler()).toBe("latexmk");
});

it.skipIf(!posix)("builds every version in one persistent folder, synced file by file", async () => {
  const builder = new Builder(loadProject(f.root), f.repo), first = await builder.build("HEAD");
  expect(first.targets).toEqual(["full"]);
  expect(fs.readFileSync(first.pdf, "utf8")).toContain("We conclude.");
  const [, folder] = builds()[0].split(" "), method = path.join(folder, "sections/method.tex");
  const untouched = fs.statSync(path.join(folder, "main.tex")).ino;
  expect(fs.readFileSync(`${runs}.args`, "utf8")).toBe("build --engine pdflatex --synctex -o build main.tex\n");
  // The working copy of the main file inputs the outline trace first, on its
  // first line, so every line keeps its number.
  const traced = fs.readFileSync(path.join(folder, "main.tex"), "utf8"), original = f.read("paper/main.tex");
  expect(traced).toBe(String.raw`\input{../papilot-trace.tex}\ifcsname papilot@w\endcsname\edef\CurrentFile{\detokenize{main.tex}}\def\CurrentFilePath{}\csname papilot@w\endcsname{F|0||\CurrentFile}\fi` + original);
  expect(fs.readFileSync(path.join(folder, "../papilot-trace.tex"), "utf8")).toBe(OUTLINE_TRACE + "\n");

  // An edit, a new file and a removed one reach the working folder; the
  // unchanged main file stays the same file.
  f.write("paper/sections/extra.tex", "Extra.\n");
  fs.rmSync(path.join(f.root, "paper/sections/method.tex"));
  commit("paper/main.tex", f.read("paper/main.tex"));
  const second = await builder.build("HEAD");
  expect(builds()).toEqual([`build ${folder}`, `build ${folder}`]);
  expect(fs.existsSync(method)).toBe(false);
  expect(fs.readFileSync(path.join(folder, "sections/extra.tex"), "utf8")).toBe("Extra.\n");
  expect(fs.statSync(path.join(folder, "main.tex")).ino).toBe(untouched);

  // Each build keeps its own output, with SyncTeX naming its own sources.
  expect(second.key).not.toBe(first.key);
  expect(path.dirname(second.pdf)).toBe(path.join(second.cwd, "build"));
  expect(fs.readFileSync(first.pdf, "utf8")).toContain("\\section{Method}");
  expect(fs.readFileSync(second.pdf, "utf8")).toContain("Extra.");
  const synctex = gunzipSync(fs.readFileSync(path.join(second.cwd, "build/main.synctex.gz"))).toString();
  expect(synctex).toContain(`Input:1:${second.cwd}/./main.tex`);
});

it.skipIf(!posix)("accepts a build whose PDF did not change, and creates the folders of included files", async () => {
  const builder = new Builder(loadProject(f.root), f.repo), first = await builder.build("HEAD");
  // A file the document does not read: PhiTeX leaves the identical PDF.
  commit("paper/notes.txt", "Notes.\n");
  const second = await builder.build("HEAD");
  expect(fs.readFileSync(second.pdf, "utf8")).toBe(fs.readFileSync(first.pdf, "utf8"));
  expect(second.errors).toBeUndefined();

  commit("paper/chapters/one.tex", "One.\n");
  commit("paper/main.tex", f.read("paper/main.tex").replace("We conclude.", "We conclude.\n\\include{chapters/one}"));
  const included = await builder.build("HEAD");
  expect(included.errors).toBeUndefined();
  expect(fs.readFileSync(path.join(included.cwd, "build/chapters/one.aux"), "utf8")).toBe("\\relax\n");
});

it.skipIf(!posix)("refreshes a symlinked main file when its target changes", async () => {
  const main = path.join(f.root, "paper/main.tex"), target = "paper/document.tex";
  fs.renameSync(main, path.join(f.root, target));
  fs.symlinkSync("document.tex", main);
  commit(target, f.read(target));
  const builder = new Builder(loadProject(f.root), f.repo), first = await builder.build("HEAD");
  expect(fs.readFileSync(first.pdf, "utf8")).toContain("We conclude.");

  commit(target, f.read(target).replace("We conclude.", "The linked document changed."));
  const second = await builder.build("HEAD");
  expect(second.key).not.toBe(first.key);
  expect(fs.readFileSync(second.pdf, "utf8")).toContain("The linked document changed.");
  expect(fs.readFileSync(first.pdf, "utf8")).toContain("We conclude.");
  const [, folder] = builds()[0].split(" "), tracedMain = path.join(folder, "main.tex");
  const modified = fs.statSync(tracedMain).mtimeMs;
  commit("paper/notes.txt", "Unrelated notes.\n");
  await builder.build("HEAD");
  expect(fs.statSync(tracedMain).mtimeMs).toBe(modified);
  expect(fs.readlinkSync(main)).toBe("document.tex");
  expect(f.read(target)).not.toContain("papilot-trace");
});

it.skipIf(!posix)("starts clean when recompiled by hand, without anything an earlier build wrote", async () => {
  const builder = new Builder(loadProject(f.root), f.repo);
  await builder.build("HEAD");
  const [, folder] = builds()[0].split(" ");
  fs.writeFileSync(path.join(folder, "build/main.package-list"), "stale");
  fs.writeFileSync(path.join(folder, "_minted.cache"), "stale");
  await builder.build("HEAD", ["full"], null, { force: true });
  expect(builds().map((line) => line.split(" ")[0])).toEqual(["build", "clean", "build"]);
  expect(fs.existsSync(path.join(folder, "build/main.package-list"))).toBe(false);
  expect(fs.existsSync(path.join(folder, "_minted.cache"))).toBe(false);
  expect(fs.readFileSync(path.join(folder, "main.tex"), "utf8")).toContain("\\input{../papilot-trace.tex}");
});

it.skipIf(!posix)("retries clean when a file an earlier build wrote breaks the build", async () => {
  const builder = new Builder(loadProject(f.root), f.repo);
  await builder.build("HEAD");
  const [, folder] = builds()[0].split(" ");
  fs.writeFileSync(path.join(folder, "build/main.toc"), "CORRUPT");
  commit("paper/main.tex", f.read("paper/main.tex").replace("We conclude.", "We conclude, again."));
  const retried = await builder.build("HEAD");
  expect(retried.errors).toBeUndefined();
  expect(builds().map((line) => line.split(" ")[0])).toEqual(["build", "build", "clean", "build"]);
});

it.skipIf(!posix)("continues past errors unless the paper halts on them, and never returns an earlier PDF", async () => {
  const builder = new Builder(loadProject(f.root), f.repo);
  await builder.build("HEAD");
  commit("paper/main.tex", f.read("paper/main.tex").replace("We conclude.", "We conclude. BROKEN"));
  const broken = await builder.build("HEAD");
  expect(broken.errors?.join("\n")).toContain("Undefined control sequence.");
  expect(fs.readFileSync(broken.pdf, "utf8")).toContain("BROKEN");

  writeSettings(f.root, { halt_on_error: true });
  await expect(new Builder(loadProject(f.root), f.repo).build("HEAD")).rejects.toBeInstanceOf(BuildError);
  writeSettings(f.root, {});

  // The working folder still holds the last PDF; a fatal build must fail.
  commit("paper/main.tex", f.read("paper/main.tex").replace("BROKEN", "FATAL"));
  const fatal = await builder.build("HEAD").catch((error: unknown) => error);
  expect(fatal).toBeInstanceOf(BuildError);
  expect((fatal as BuildError).details.join("\n")).toContain("Fatal error occurred");
  // Nor may a build that stopped before writing one, whatever the log says.
  commit("paper/main.tex", f.read("paper/main.tex").replace("FATAL", "NOPDF"));
  const unwritten = await builder.build("HEAD").catch((error: unknown) => error);
  expect(unwritten).toBeInstanceOf(BuildError);
  expect((unwritten as BuildError).details.join("\n")).toContain("can't write build/main.pdf");
});

it.skipIf(!posix)("says how to get PhiTeX when it is not installed", async () => {
  process.env.PATH = previous.PATH;
  await expect(new Builder(loadProject(f.root), f.repo).build("HEAD")).rejects.toThrow("PhiTeX was not found. Install it from phitex.org, or choose latexmk in Settings.");
});
