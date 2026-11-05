import { describe, expect, it } from "vitest";
import type { Tree } from "./dropped";
import { type UploadDeps, uploadTree } from "./upload";

const file = (name: string, size = 10) => ({ name, size }) as File;

/** A Drive that makes folders with ids, and takes files. */
function fake(failOn: string[] = []) {
  const made: string[] = [];
  const sent: string[] = [];
  const deps: UploadDeps = {
    makeFolder: async (parent, name) => {
      if (failOn.includes(name)) throw new Error(`no room for ${name}`);
      made.push(`${parent}/${name}`);
      return { id: `${parent}/${name}` };
    },
    send: async (f, folder) => {
      sent.push(`${folder}:${f.name}`);
      return { done: Promise.resolve() };
    },
    reason: (e) => (e as Error).message,
  };
  return { deps, made, sent };
}

const tree: Tree = {
  dirs: [["Photos", "2024"], ["Photos"]],
  files: [
    { path: [], file: file("loose.txt") },
    { path: ["Photos"], file: file("a.jpg") },
    { path: ["Photos", "2024"], file: file("b.jpg") },
  ],
};

describe("uploading what was dropped", () => {
  it("makes the outer folder before the folder inside it, and puts each file in the folder it sat in", async () => {
    const { deps, made, sent } = fake();
    const done = await uploadTree(tree, "root", null, deps);
    expect(made).toEqual(["root/Photos", "root/Photos/2024"]);
    expect(sent).toEqual(["root:loose.txt", "root/Photos:a.jpg", "root/Photos/2024:b.jpg"]);
    expect(done.sent.map((s) => s.name)).toEqual(["loose.txt", "Photos/a.jpg", "Photos/2024/b.jpg"]);
    expect(done.left).toEqual([]);
    expect(done.folders).toBe(2);
  });

  it("leaves out the files of a folder it could not make, and says why", async () => {
    const { deps, sent } = fake(["Photos"]);
    const done = await uploadTree(tree, "root", null, deps);
    expect(sent).toEqual(["root:loose.txt"]);
    expect(done.left).toEqual([
      { name: "Photos/a.jpg", reason: "no room for Photos" },
      { name: "Photos/2024/b.jpg", reason: "no room for Photos" },
    ]);
  });

  it("goes on without a folder inside that failed, not without its siblings", async () => {
    const { deps, sent } = fake(["2024"]);
    const done = await uploadTree(tree, "root", null, deps);
    expect(sent).toEqual(["root:loose.txt", "root/Photos:a.jpg"]);
    expect(done.left.map((l) => l.name)).toEqual(["Photos/2024/b.jpg"]);
  });

  it("leaves out a file over the largest Drive takes, before sending any bytes", async () => {
    const { deps, sent } = fake();
    const big: Tree = { dirs: [], files: [{ path: [], file: file("small.txt", 1024) }, { path: [], file: file("disk.iso", 5 * 1024 * 1024) }] };
    const done = await uploadTree(big, "root", 2 * 1024 * 1024, deps);
    expect(sent).toEqual(["root:small.txt"]);
    expect(done.left).toEqual([{ name: "disk.iso", reason: "it is 5.0 MB and the most Drive takes is 2.0 MB" }]);
  });

  it("sends a file past it in parts, to be adopted, when that is offered", async () => {
    const { deps, sent } = fake();
    const large: string[] = [];
    const big: Tree = { dirs: [], files: [{ path: [], file: file("small.txt", 1024) }, { path: [], file: file("disk.iso", 5 * 1024 * 1024) }] };
    const done = await uploadTree(big, "root", 2 * 1024 * 1024, {
      ...deps,
      sendLarge: (f, folder) => {
        large.push(`${folder}:${f.name}`);
        return { done: Promise.resolve() };
      },
    });
    expect([sent, large, done.left, done.sent.map((s) => s.name)]).toEqual([["root:small.txt"], ["root:disk.iso"], [], ["small.txt", "disk.iso"]]);
  });
});
