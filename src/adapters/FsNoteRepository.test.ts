import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FsNoteRepository } from "./FsNoteRepository.js";
import type { Note } from "../domain/Note.js";

describe("FsNoteRepository (Filesystem Vault Adapter)", () => {
  let tempVaultDir: string;
  let repository: FsNoteRepository;

  beforeEach(async () => {
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
    repository = new FsNoteRepository(tempVaultDir);
  });

  afterEach(async () => {
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  it("saves a note as a .md file on disk and reads it back", async () => {
    const note: Note = {
      title: "Cardiology Basics",
      frontmatter: { title: "Cardiology Basics" },
      tags: ["medicine", "cardio"],
      body: "Myocardial infarction involves ischemic necrosis of myocardium.",
    };

    await repository.save(note);

    // Verify file actually exists on physical disk
    const expectedFilePath = path.join(tempVaultDir, "Cardiology Basics.md");
    const rawFileContent = await fs.readFile(expectedFilePath, "utf-8");
    expect(rawFileContent).toContain("title: Cardiology Basics");
    expect(rawFileContent).toContain("Myocardial infarction");

    // Verify reading through the repository port
    const retrievedNote = await repository.get("Cardiology Basics");
    expect(retrievedNote).not.toBeNull();
    expect(retrievedNote?.title).toBe("Cardiology Basics");
    expect(retrievedNote?.tags).toEqual(["medicine", "cardio"]);
    expect(retrievedNote?.body).toBe(note.body);
  });

  it("returns null when getting a note that does not exist", async () => {
    const result = await repository.get("Nonexistent Note");
    expect(result).toBeNull();
  });

  it("checks existence of a note correctly with exists()", async () => {
    expect(await repository.exists("Neurology")).toBe(false);

    const note: Note = {
      title: "Neurology",
      frontmatter: {},
      tags: [],
      body: "Study of the nervous system.",
    };
    await repository.save(note);

    expect(await repository.exists("Neurology")).toBe(true);
  });

  it("lists all note titles in the vault directory", async () => {
    await repository.save({
      title: "Note A",
      frontmatter: {},
      tags: [],
      body: "Content A",
    });
    await repository.save({
      title: "Note B",
      frontmatter: {},
      tags: [],
      body: "Content B",
    });

    const titles = await repository.listTitles();
    expect(titles.sort()).toEqual(["Note A", "Note B"]);
  });

  it("deletes an existing note file from disk", async () => {
    const note: Note = {
      title: "Temporary Note",
      frontmatter: {},
      tags: [],
      body: "To be deleted",
    };
    await repository.save(note);
    expect(await repository.exists("Temporary Note")).toBe(true);

    const deleted = await repository.delete("Temporary Note");
    expect(deleted).toBe(true);
    expect(await repository.exists("Temporary Note")).toBe(false);

    // Deleting again should return false
    const deletedAgain = await repository.delete("Temporary Note");
    expect(deletedAgain).toBe(false);
  });

  it("renames an existing note file and updates internal title", async () => {
    const note: Note = {
      title: "Old Anatomy",
      frontmatter: { title: "Old Anatomy" },
      tags: ["biology"],
      body: "Gross anatomy overview.",
    };
    await repository.save(note);

    await repository.rename("Old Anatomy", "Human Anatomy");

    expect(await repository.exists("Old Anatomy")).toBe(false);
    expect(await repository.exists("Human Anatomy")).toBe(true);

    const renamedNote = await repository.get("Human Anatomy");
    expect(renamedNote?.title).toBe("Human Anatomy");
    expect(renamedNote?.frontmatter.title).toBe("Human Anatomy");
    expect(renamedNote?.tags).toEqual(["biology"]);
  });

  it("throws an error when renaming a non-existent note", async () => {
    await expect(repository.rename("Ghost Note", "New Note")).rejects.toThrow(
      'Cannot rename note: "Ghost Note" does not exist.'
    );
  });

  it("retrieves file info including mtime with getFileInfo", async () => {
    await repository.save({
      title: "Physiology",
      frontmatter: { title: "Physiology" },
      tags: [],
      body: "Content.",
    });

    const info = await repository.getFileInfo("Physiology");
    expect(info).not.toBeNull();
    expect(info?.title).toBe("Physiology");
    expect(info?.filePath).toBe("Physiology.md");
    expect(typeof info?.mtime).toBe("number");
    expect(info!.mtime).toBeGreaterThan(0);

    const nonExistent = await repository.getFileInfo("Does Not Exist");
    expect(nonExistent).toBeNull();
  });

  it("lists all files with titles, file paths, and mtimes with listAllFiles", async () => {
    await repository.save({
      title: "NoteA",
      frontmatter: { title: "NoteA" },
      tags: [],
      body: "Body A",
    });

    await repository.save({
      title: "NoteB",
      frontmatter: { title: "NoteB" },
      tags: [],
      body: "Body B",
    });

    const allFiles = await repository.listAllFiles();
    expect(allFiles.length).toBe(2);

    const titles = allFiles.map((f) => f.title).sort();
    expect(titles).toEqual(["NoteA", "NoteB"]);
    expect(allFiles[0].mtime).toBeGreaterThan(0);
    expect(allFiles[0].filePath.endsWith(".md")).toBe(true);
  });
});

