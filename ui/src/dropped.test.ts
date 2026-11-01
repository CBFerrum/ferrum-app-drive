import { describe, expect, it } from "vitest";
import { type Entry, MOST_FILES, TooMany, creationOrder, describe as tell, fromPicker, keyOf, walk } from "./dropped";

const file = (name: string): Entry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok({ name, size: 1 } as File),
});

/** A folder whose reader gives its entries in batches of `batch`, as a browser's does. */
const dir = (name: string, children: Entry[], batch = 2): Entry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (ok) => {
        const next = children.slice(at, at + batch);
        at += batch;
        ok(next);
      },
    };
  },
});

describe("files and folders dropped from the computer", () => {
  it("finds every file with the folders above it, and every folder, however a reader batches them", async () => {
    const tree = await walk([
      file("loose.txt"),
      dir("Photos", [file("a.jpg"), file("b.jpg"), file("c.jpg"), dir("2024", [file("d.jpg")]), dir("Empty", [])]),
    ]);
    expect(tree.files.map((f) => [...f.path, f.file.name].join("/"))).toEqual(["loose.txt", "Photos/a.jpg", "Photos/b.jpg", "Photos/c.jpg", "Photos/2024/d.jpg"]);
    expect(tree.dirs.map(keyOf)).toEqual(["Photos", "Photos/2024", "Photos/Empty"]);
  });

  it("leaves out what a system scatters in folders", async () => {
    const tree = await walk([dir("Docs", [file(".DS_Store"), file("Thumbs.db"), file("._a.txt"), file("a.txt")])]);
    expect(tree.files.map((f) => f.file.name)).toEqual(["a.txt"]);
  });

  it("refuses a drop of more files than a page can carry", async () => {
    const many = dir(
      "Big",
      Array.from({ length: MOST_FILES + 1 }, (_, i) => file(`f${i}.txt`)),
      500,
    );
    await expect(walk([many])).rejects.toBeInstanceOf(TooMany);
    await expect(walk([dir("Fits", Array.from({ length: MOST_FILES }, (_, i) => file(`f${i}.txt`)), 500)])).resolves.toMatchObject({ files: expect.any(Array) });
  });

  it("reads the folder picker's files by where they sit", () => {
    const f = (path: string) => Object.assign({ name: path.split("/").pop()! } as File, { webkitRelativePath: path });
    const tree = fromPicker([f("Photos/a.jpg"), f("Photos/2024/b.jpg"), f("Photos/2024/c.jpg"), f("Photos/.DS_Store")]);
    expect(tree.dirs.map(keyOf)).toEqual(["Photos", "Photos/2024"]);
    expect(tree.files.map((x) => [...x.path, x.file.name].join("/"))).toEqual(["Photos/a.jpg", "Photos/2024/b.jpg", "Photos/2024/c.jpg"]);
    expect(fromPicker([f("lone.txt")]).files[0].path).toEqual([]);
  });

  it("makes outer folders before the folders inside them", () => {
    const order = creationOrder([["A", "B", "C"], ["A"], ["A", "B"], ["Z"]]).map(keyOf);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("A/B"));
    expect(order.indexOf("A/B")).toBeLessThan(order.indexOf("A/B/C"));
  });

  it("tells what was dropped", () => {
    expect(tell({ dirs: [], files: [{ path: [], file: {} as File }] })).toBe("1 file");
    expect(tell({ dirs: [["A"]], files: [{ path: ["A"], file: {} as File }, { path: ["A"], file: {} as File }] })).toBe("2 files in 1 folder");
  });
});
