import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { RefactorService, RefactorRollbackError } from "./RefactorService.js";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";
import { NoteParser } from "../domain/NoteParser.js";

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
    let forwardTriggerDone = false;
    const originalUpsert = indexStore.upsertNote.bind(indexStore);
    indexStore.upsertNote = async (record) => {
      if (record.title === "RefNote" && !forwardTriggerDone) {
        forwardTriggerDone = true;
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

  it("unindexes newly indexed referencing note on rollback if it was previously unindexed", async () => {
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

    // Referencing note exists in repo, but has NOT been indexed yet in SQLite
    await noteRepo.save({
      title: "UnindexedRef",
      body: "Mentions [[TargetNote]].",
      tags: [],
      frontmatter: { title: "UnindexedRef" },
      links: ["TargetNote"],
    });

    // Second referencing note
    await noteRepo.save({
      title: "RefTwo",
      body: "Also mentions [[TargetNote]].",
      tags: [],
      frontmatter: { title: "RefTwo" },
      links: ["TargetNote"],
    });

    // Mock getBacklinks so RefactorService discovers both
    indexStore.getBacklinks = async () => ["UnindexedRef", "RefTwo"];

    // Simulate failure on second upsert
    let upsertCount = 0;
    const origUpsert = indexStore.upsertNote.bind(indexStore);
    indexStore.upsertNote = async (record) => {
      upsertCount++;
      if (upsertCount === 1) {
        // First upsert for UnindexedRef succeeds
        return origUpsert(record);
      }
      // Fail on second upsert to trigger rollback
      throw new Error("Simulated failure after indexing unindexed note");
    };

    await expect(refactorService.renameNote("TargetNote", "NewTargetNote")).rejects.toThrow(
      "Simulated failure after indexing unindexed note"
    );

    // After rollback, UnindexedRef must not remain in the index
    const meta = await indexStore.getNoteMetadata("UnindexedRef");
    expect(meta).toBeNull();
  });

  it("throws error if referencing note discovered in index is missing on disk in the vault", async () => {
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

    // Mock getBacklinks returning a title that does NOT exist on disk
    indexStore.getBacklinks = async () => ["DeletedOrMissingNote"];

    await expect(refactorService.renameNote("TargetNote", "NewTargetNote")).rejects.toThrow(
      'Cannot refactor note "TargetNote": referencing note "DeletedOrMissingNote" found in index does not exist in the vault.'
    );

    // Target note remains untouched on disk and in index
    expect(await noteRepo.exists("TargetNote")).toBe(true);
    expect(await noteRepo.exists("NewTargetNote")).toBe(false);
  });

  it("restores original mtime and updatedAt metadata of target note on rollback", async () => {
    const originalMtime = 1000000000;
    const originalUpdatedAt = "2020-01-01T00:00:00.000Z";

    await noteRepo.save({
      title: "TargetNote",
      body: "Target content.",
      tags: ["tag1"],
      frontmatter: { title: "TargetNote", updatedAt: originalUpdatedAt },
      links: [],
    });
    await indexStore.upsertNote({
      title: "TargetNote",
      filePath: "TargetNote.md",
      mtime: originalMtime,
      updatedAt: originalUpdatedAt,
      tags: ["tag1"],
      links: [],
    });

    // Setup referencing note
    await noteRepo.save({
      title: "Caller",
      body: "Mentions [[TargetNote]].",
      tags: [],
      frontmatter: { title: "Caller" },
      links: ["TargetNote"],
    });
    await indexStore.upsertNote({
      title: "Caller",
      filePath: "Caller.md",
      mtime: Date.now(),
      tags: [],
      links: ["TargetNote"],
    });

    // Simulate failure during referencing note index upsert
    const origUpsert = indexStore.upsertNote.bind(indexStore);
    indexStore.upsertNote = async (record) => {
      if (record.title === "Caller") {
        throw new Error("Trigger index failure on referencing note");
      }
      return origUpsert(record);
    };

    await expect(refactorService.renameNote("TargetNote", "NewTargetNote")).rejects.toThrow(
      "Trigger index failure on referencing note"
    );

    // Prior target metadata must be restored exactly
    const targetMeta = await indexStore.getNoteMetadata("TargetNote");
    expect(targetMeta).not.toBeNull();
    expect(targetMeta?.mtime).toBe(originalMtime);
    expect(targetMeta?.updatedAt).toBe(originalUpdatedAt);
    expect(targetMeta?.tags).toEqual(["tag1"]);
  });

  it("skips saving and reporting referencing notes whose content did not actually change", async () => {
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
      mtime: 1000,
      tags: [],
      links: [],
    });

    // CallerOne has an actual link
    await noteRepo.save({
      title: "CallerOne",
      body: "Links to [[TargetNote]].",
      tags: [],
      frontmatter: { title: "CallerOne" },
      links: ["TargetNote"],
    });
    await indexStore.upsertNote({
      title: "CallerOne",
      filePath: "CallerOne.md",
      mtime: 1000,
      tags: [],
      links: ["TargetNote"],
    });

    // CallerTwo has a backlink in index, but in body it's inside a code block (so body won't change)
    await noteRepo.save({
      title: "CallerTwo",
      body: "Code block:\n```\n[[TargetNote]]\n```",
      tags: [],
      frontmatter: { title: "CallerTwo" },
      links: ["TargetNote"],
    });
    await indexStore.upsertNote({
      title: "CallerTwo",
      filePath: "CallerTwo.md",
      mtime: 1000,
      tags: [],
      links: ["TargetNote"],
    });

    const result = await refactorService.renameNote("TargetNote", "RenamedTarget");

    // Only CallerOne should be updated and reported
    expect(result.updatedReferencingNotes).toEqual(["CallerOne"]);

    // CallerTwo's metadata in index should remain untouched
    const metaTwo = await indexStore.getNoteMetadata("CallerTwo");
    expect(metaTwo?.mtime).toBe(1000);
  });

  it("discovers and refactors incoming backlinks that include heading anchors", async () => {
    await noteRepo.save({
      title: "TargetNote",
      body: "# Target Header\nContent.",
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

    const callerBody = "See [[TargetNote#Target Header]] and [[TargetNote#Target Header|Alias]].";
    const extractedLinks = NoteParser.extractWikiLinks(callerBody);
    await noteRepo.save({
      title: "AnchorCaller",
      body: callerBody,
      tags: [],
      frontmatter: { title: "AnchorCaller" },
      links: extractedLinks,
    });
    await indexStore.upsertNote({
      title: "AnchorCaller",
      filePath: "AnchorCaller.md",
      mtime: Date.now(),
      tags: [],
      links: extractedLinks,
    });

    const result = await refactorService.renameNote("TargetNote", "RenamedNote");
    expect(result.updatedReferencingNotes).toEqual(["AnchorCaller"]);

    const updatedCaller = await noteRepo.get("AnchorCaller");
    expect(updatedCaller?.body).toBe(
      "See [[RenamedNote#Target Header]] and [[RenamedNote#Target Header|Alias]]."
    );
  });
});
