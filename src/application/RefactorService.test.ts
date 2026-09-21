import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { RefactorService, RefactorRollbackError } from "./RefactorService.js";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";

describe("RefactorService (Application Note Refactoring)", () => {
  let tempVaultDir: string;
  let noteRepo: FsNoteRepository;
  let indexStore: SqliteIndexStore;
  let refactorService: RefactorService;

  beforeEach(async () => {
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "refactor-service-test-"));
    noteRepo = new FsNoteRepository(tempVaultDir);
    indexStore = new SqliteIndexStore(":memory:");
    refactorService = new RefactorService(noteRepo, indexStore);
  });

  afterEach(async () => {
    await indexStore.close();
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  it("renames file on disk, updates frontmatter title, rewrites referencing wiki-links, and updates SQLite index", async () => {
    // Setup target note
    await noteRepo.save({
      title: "OldTarget",
      body: "Original target content.",
      tags: ["target"],
      frontmatter: { title: "OldTarget", tags: ["target"] },
      links: [],
    });
    await indexStore.upsertNote({
      title: "OldTarget",
      filePath: "OldTarget.md",
      mtime: Date.now(),
      tags: ["target"],
      links: [],
    });

    // Setup referencing notes
    await noteRepo.save({
      title: "CallerOne",
      body: "See [[OldTarget]] and [[OldTarget|Target Alias]].",
      tags: ["caller"],
      frontmatter: { title: "CallerOne", tags: ["caller"] },
      links: ["OldTarget"],
    });
    await indexStore.upsertNote({
      title: "CallerOne",
      filePath: "CallerOne.md",
      mtime: Date.now(),
      tags: ["caller"],
      links: ["OldTarget"],
    });

    await noteRepo.save({
      title: "CallerTwo",
      body: "Also references [[OldTarget]].",
      tags: [],
      frontmatter: { title: "CallerTwo" },
      links: ["OldTarget"],
    });
    await indexStore.upsertNote({
      title: "CallerTwo",
      filePath: "CallerTwo.md",
      mtime: Date.now(),
      tags: [],
      links: ["OldTarget"],
    });

    const result = await refactorService.renameNote("OldTarget", "NewTarget");

    expect(result.oldTitle).toBe("OldTarget");
    expect(result.newTitle).toBe("NewTarget");
    expect(result.updatedReferencingNotes.sort()).toEqual(["CallerOne", "CallerTwo"]);

    // 1. Physical file on disk
    expect(await noteRepo.exists("OldTarget")).toBe(false);
    expect(await noteRepo.exists("NewTarget")).toBe(true);

    const renamedDiskNote = await noteRepo.get("NewTarget");
    expect(renamedDiskNote?.title).toBe("NewTarget");
    expect(renamedDiskNote?.frontmatter.title).toBe("NewTarget");

    // 2. Referencing files on disk
    const diskCallerOne = await noteRepo.get("CallerOne");
    expect(diskCallerOne?.body).toBe("See [[NewTarget]] and [[NewTarget|Target Alias]].");

    const diskCallerTwo = await noteRepo.get("CallerTwo");
    expect(diskCallerTwo?.body).toBe("Also references [[NewTarget]].");

    // 3. SQLite index graph
    expect(await indexStore.getBacklinks("OldTarget")).toEqual([]);
    expect(await indexStore.getBacklinks("NewTarget")).toEqual(["CallerOne", "CallerTwo"]);
    expect(await indexStore.getOutboundLinks("CallerOne")).toEqual(["NewTarget"]);
  });

  it("returns early if old and new titles are identical", async () => {
    const result = await refactorService.renameNote("SameName", "SameName");
    expect(result).toEqual({
      oldTitle: "SameName",
      newTitle: "SameName",
      updatedReferencingNotes: [],
    });
  });

  it("throws error when title is empty or whitespace", async () => {
    await expect(refactorService.renameNote("", "NewName")).rejects.toThrow(
      "Note title cannot be empty."
    );
    await expect(refactorService.renameNote("OldName", "   ")).rejects.toThrow(
      "Note title cannot be empty."
    );
  });

  it("throws error when trying to rename a non-existent note", async () => {
    await expect(refactorService.renameNote("GhostNote", "Any")).rejects.toThrow(
      'Cannot rename note: "GhostNote" does not exist.'
    );
  });

  it("throws error when target name already exists", async () => {
    await noteRepo.save({
      title: "Note1",
      body: "Content 1",
      tags: [],
      frontmatter: { title: "Note1" },
      links: [],
    });
    await noteRepo.save({
      title: "Note2",
      body: "Content 2",
      tags: [],
      frontmatter: { title: "Note2" },
      links: [],
    });

    await expect(refactorService.renameNote("Note1", "Note2")).rejects.toThrow(
      'Cannot rename note: "Note2" already exists.'
    );
  });

  it("updates self-referential links within the renamed note itself", async () => {
    await noteRepo.save({
      title: "RecursiveNote",
      body: "Refers to [[RecursiveNote]].",
      tags: [],
      frontmatter: { title: "RecursiveNote" },
      links: ["RecursiveNote"],
    });
    await indexStore.upsertNote({
      title: "RecursiveNote",
      filePath: "RecursiveNote.md",
      mtime: Date.now(),
      tags: [],
      links: ["RecursiveNote"],
    });

    await refactorService.renameNote("RecursiveNote", "NewRecursiveNote");

    const diskNote = await noteRepo.get("NewRecursiveNote");
    expect(diskNote?.body).toBe("Refers to [[NewRecursiveNote]].");
    expect(await indexStore.getBacklinks("NewRecursiveNote")).toEqual(["NewRecursiveNote"]);
  });

  it("atomically rolls back all disk modifications if writing to a referencing file fails", async () => {
    await noteRepo.save({
      title: "TargetToRename",
      body: "Target body.",
      tags: [],
      frontmatter: { title: "TargetToRename" },
      links: [],
    });
    await indexStore.upsertNote({
      title: "TargetToRename",
      filePath: "TargetToRename.md",
      mtime: Date.now(),
      tags: [],
      links: [],
    });

    await noteRepo.save({
      title: "SafeCaller",
      body: "Links to [[TargetToRename]].",
      tags: [],
      frontmatter: { title: "SafeCaller" },
      links: ["TargetToRename"],
    });
    await indexStore.upsertNote({
      title: "SafeCaller",
      filePath: "SafeCaller.md",
      mtime: Date.now(),
      tags: [],
      links: ["TargetToRename"],
    });

    await noteRepo.save({
      title: "FaultyCaller",
      body: "Links to [[TargetToRename]].",
      tags: [],
      frontmatter: { title: "FaultyCaller" },
      links: ["TargetToRename"],
    });
    await indexStore.upsertNote({
      title: "FaultyCaller",
      filePath: "FaultyCaller.md",
      mtime: Date.now(),
      tags: [],
      links: ["TargetToRename"],
    });

    // Simulate failure when saving FaultyCaller
    const originalSave = noteRepo.save.bind(noteRepo);
    noteRepo.save = async (note) => {
      if (note.title === "FaultyCaller") {
        throw new Error("Simulated disk I/O failure on FaultyCaller");
      }
      return originalSave(note);
    };

    await expect(
      refactorService.renameNote("TargetToRename", "AbortedNewTarget")
    ).rejects.toThrow("Simulated disk I/O failure on FaultyCaller");

    // TargetToRename still exists and AbortedNewTarget does not
    expect(await noteRepo.exists("TargetToRename")).toBe(true);
    expect(await noteRepo.exists("AbortedNewTarget")).toBe(false);

    // SafeCaller was rolled back to link to TargetToRename
    const rolledBackCaller = await noteRepo.get("SafeCaller");
    expect(rolledBackCaller?.body).toBe("Links to [[TargetToRename]].");
  });

  it("atomically rolls back both disk modifications and SQLite index rename if re-indexing referencing notes fails", async () => {
    await noteRepo.save({
      title: "TargetNote",
      body: "Target content.",
      tags: [],
      frontmatter: { title: "TargetNote" },
      links: [],
    });
    await indexStore.upsertNote({
      title: "TargetNote",
      filePath: "TargetNote.md",
      mtime: Date.now(),
      tags: [],
      links: [],
    });

    await noteRepo.save({
      title: "ReferencingNote",
      body: "Mentions [[TargetNote]].",
      tags: [],
      frontmatter: { title: "ReferencingNote" },
      links: ["TargetNote"],
    });
    await indexStore.upsertNote({
      title: "ReferencingNote",
      filePath: "ReferencingNote.md",
      mtime: Date.now(),
      tags: [],
      links: ["TargetNote"],
    });

    const originalUpsert = indexStore.upsertNote.bind(indexStore);
    indexStore.upsertNote = async (record) => {
      if (record.title === "ReferencingNote") {
        throw new Error("Simulated index failure on referencing note");
      }
      return originalUpsert(record);
    };

    await expect(refactorService.renameNote("TargetNote", "NewTargetNote")).rejects.toThrow(
      "Simulated index failure on referencing note"
    );

    // Disk rollback
    expect(await noteRepo.exists("TargetNote")).toBe(true);
    expect(await noteRepo.exists("NewTargetNote")).toBe(false);

    // SQLite rollback
    const indexedTitles = await indexStore.listAllIndexedTitles();
    expect(indexedTitles).toContain("TargetNote");
    expect(indexedTitles).not.toContain("NewTargetNote");
    expect(await indexStore.getBacklinks("TargetNote")).toEqual(["ReferencingNote"]);
  });

  it("throws RefactorRollbackError if any compensating action in the rollback stack fails", async () => {
    await noteRepo.save({
      title: "TargetNote",
      body: "Target content.",
      tags: [],
      frontmatter: { title: "TargetNote" },
      links: [],
    });
    await indexStore.upsertNote({
      title: "TargetNote",
      filePath: "TargetNote.md",
      mtime: Date.now(),
      tags: [],
      links: [],
    });

    await noteRepo.save({
      title: "RefNote",
      body: "Links to [[TargetNote]].",
      tags: [],
      frontmatter: { title: "RefNote" },
      links: ["TargetNote"],
    });
    await indexStore.upsertNote({
      title: "RefNote",
      filePath: "RefNote.md",
      mtime: Date.now(),
      tags: [],
      links: ["TargetNote"],
    });

    // Make upsert fail on forward execution to trigger rollback
    let upsertCalls = 0;
    const originalUpsert = indexStore.upsertNote.bind(indexStore);
    indexStore.upsertNote = async (record) => {
      upsertCalls++;
      if (upsertCalls === 1 && record.title === "RefNote") {
        throw new Error("Trigger index error");
      }
      return originalUpsert(record);
    };

    // Make delete fail during rollback of new note
    const originalDelete = noteRepo.delete.bind(noteRepo);
    noteRepo.delete = async (title) => {
      if (title === "NewTargetNote") {
        throw new Error("Disk unlink permission denied during rollback");
      }
      return originalDelete(title);
    };

    try {
      await refactorService.renameNote("TargetNote", "NewTargetNote");
      expect.unreachable("Should have thrown RefactorRollbackError");
    } catch (err) {
      expect(err).toBeInstanceOf(RefactorRollbackError);
      const rollbackErr = err as RefactorRollbackError;
      expect((rollbackErr.triggerError as Error).message).toBe("Trigger index error");
      expect(rollbackErr.rollbackErrors.length).toBeGreaterThan(0);
      expect(rollbackErr.rollbackErrors[0].message).toBe(
        "Disk unlink permission denied during rollback"
      );
    }
  });
});
