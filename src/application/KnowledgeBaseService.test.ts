import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { KnowledgeBaseService } from "./KnowledgeBaseService.js";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";

describe("KnowledgeBaseService (Application Service Facade)", () => {
  let tempVaultDir: string;
  let noteRepo: FsNoteRepository;
  let indexStore: SqliteIndexStore;
  let service: KnowledgeBaseService;

  beforeEach(async () => {
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-service-test-"));
    noteRepo = new FsNoteRepository(tempVaultDir);
    indexStore = new SqliteIndexStore(":memory:");
    service = new KnowledgeBaseService(noteRepo, indexStore);
  });

  afterEach(async () => {
    await indexStore.close();
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  it("creates a note on disk and indexes its metadata and tags simultaneously", async () => {
    const createdNote = await service.createNote({
      title: "Cardiology",
      body: "Myocardial infarction is necrosis of heart muscle.",
      tags: ["medicine", "cardio"],
    });

    expect(createdNote.title).toBe("Cardiology");
    expect(createdNote.tags).toEqual(["medicine", "cardio"]);

    // 1. Verify file exists on disk
    const diskNote = await noteRepo.get("Cardiology");
    expect(diskNote).not.toBeNull();
    expect(diskNote?.body).toBe("Myocardial infarction is necrosis of heart muscle.");

    // 2. Verify indexed in SQLite
    const searchResults = await service.searchByTag("cardio");
    expect(searchResults).toEqual(["Cardiology"]);

    const metadata = await indexStore.getNoteMetadata("Cardiology");
    expect(metadata?.tags.sort()).toEqual(["cardio", "medicine"]);
  });

  it("throws an error when trying to create a note with a duplicate title", async () => {
    await service.createNote({
      title: "Duplicate Title",
      body: "First version",
    });

    await expect(
      service.createNote({
        title: "Duplicate Title",
        body: "Second version",
      })
    ).rejects.toThrow('Note with title "Duplicate Title" already exists.');
  });

  it("retrieves an existing note with getNote()", async () => {
    await service.createNote({
      title: "Neurology",
      body: "Brain and nervous system.",
    });

    const note = await service.getNote("Neurology");
    expect(note).not.toBeNull();
    expect(note?.title).toBe("Neurology");
    expect(note?.body).toBe("Brain and nervous system.");

    const nonExistent = await service.getNote("Ghost");
    expect(nonExistent).toBeNull();
  });

  it("deletes a note from disk and removes it from the SQLite index", async () => {
    await service.createNote({
      title: "Temporary",
      tags: ["temp"],
    });

    expect(await service.searchByTag("temp")).toEqual(["Temporary"]);

    const deleted = await service.deleteNote("Temporary");
    expect(deleted).toBe(true);

    expect(await noteRepo.exists("Temporary")).toBe(false);
    expect(await service.searchByTag("temp")).toEqual([]);
  });

  it("extracts Wiki-links and populates the SQLite link graph upon note creation", async () => {
    const note = await service.createNote({
      title: "IndexNote",
      body: "Check out [[NoteA]] and [[NoteB]], along with duplicate [[NoteA]]. Also inline `[[Ignored]]`.",
    });

    expect(note.links).toEqual(["NoteA", "NoteB"]);

    const outboundLinks = await service.getOutboundLinks("IndexNote");
    expect(outboundLinks).toEqual(["NoteA", "NoteB"]);

    const metadata = await indexStore.getNoteMetadata("IndexNote");
    expect(metadata?.links).toEqual(["NoteA", "NoteB"]);
  });

  it("replaces old outbound links when a note is updated", async () => {
    await service.createNote({
      title: "MutableNote",
      body: "Initially connects to [[OldTarget1]] and [[OldTarget2]].",
    });

    expect(await service.getOutboundLinks("MutableNote")).toEqual(["OldTarget1", "OldTarget2"]);

    // Update note body with different links
    await service.updateNote("MutableNote", {
      body: "Now connects only to [[NewTarget]] and [[OldTarget2]].",
    });

    const updatedLinks = await service.getOutboundLinks("MutableNote");
    expect(updatedLinks).toEqual(["NewTarget", "OldTarget2"]);
  });

  it("cleans up outbound links when a note is deleted", async () => {
    await service.createNote({
      title: "EphemeralNote",
      body: "Links to [[Ghost1]] and [[Ghost2]].",
    });

    expect(await service.getOutboundLinks("EphemeralNote")).toEqual(["Ghost1", "Ghost2"]);

    const deleted = await service.deleteNote("EphemeralNote");
    expect(deleted).toBe(true);

    expect(await service.getOutboundLinks("EphemeralNote")).toEqual([]);
  });

  it("retrieves incoming backlinks through KnowledgeBaseService", async () => {
    await service.createNote({
      title: "DocA",
      body: "References [[CentralTopic]].",
    });
    await service.createNote({
      title: "DocB",
      body: "Also references [[CentralTopic]] and [[OtherTopic]].",
    });
    await service.createNote({
      title: "CentralTopic",
      body: "Core topic definition.",
    });

    const backlinks = await service.getBacklinks("CentralTopic");
    expect(backlinks).toEqual(["DocA", "DocB"]);

    const otherBacklinks = await service.getBacklinks("OtherTopic");
    expect(otherBacklinks).toEqual(["DocB"]);

    const nonReferenced = await service.getBacklinks("DocA");
    expect(nonReferenced).toEqual([]);
  });

  it("discovers ghost notes across the vault and resolves them when authored", async () => {
    await service.createNote({
      title: "Architecture",
      body: "Mentions [[HexagonalPattern]] and [[EventDrivenPattern]].",
    });

    const initialGhosts = await service.getGhostNotes();
    expect(initialGhosts).toEqual([
      { targetTitle: "EventDrivenPattern", referencedBy: ["Architecture"] },
      { targetTitle: "HexagonalPattern", referencedBy: ["Architecture"] },
    ]);

    // Now author HexagonalPattern
    await service.createNote({
      title: "HexagonalPattern",
      body: "Ports and Adapters architecture.",
    });

    const afterAuthoringGhosts = await service.getGhostNotes();
    expect(afterAuthoringGhosts).toEqual([
      { targetTitle: "EventDrivenPattern", referencedBy: ["Architecture"] },
    ]);
  });

  it("handles complex vault graph topologies (cyclic, self-referential, diamond, isolated)", async () => {
    // 1. Self-referential note
    await service.createNote({
      title: "Recursion",
      body: "See [[Recursion]] for recursion.",
    });

    // 2. Cyclic loop: CyclicA -> CyclicB -> CyclicA
    await service.createNote({
      title: "CyclicA",
      body: "Points to [[CyclicB]].",
    });
    await service.createNote({
      title: "CyclicB",
      body: "Points back to [[CyclicA]] and points to [[UnauthoredGhost]].",
    });

    // 3. Diamond pattern: DiamRoot -> DiamLeft & DiamRight -> DiamLeaf
    await service.createNote({
      title: "DiamRoot",
      body: "Branches to [[DiamLeft]] and [[DiamRight]].",
    });
    await service.createNote({
      title: "DiamLeft",
      body: "Converges to [[DiamLeaf]].",
    });
    await service.createNote({
      title: "DiamRight",
      body: "Converges to [[DiamLeaf]].",
    });
    await service.createNote({
      title: "DiamLeaf",
      body: "Terminal node.",
    });

    // 4. Isolated node
    await service.createNote({
      title: "Island",
      body: "No connections anywhere.",
    });

    // Assert self-reference
    expect(await service.getBacklinks("Recursion")).toEqual(["Recursion"]);

    // Assert cyclic backlinks
    expect(await service.getBacklinks("CyclicA")).toEqual(["CyclicB"]);
    expect(await service.getBacklinks("CyclicB")).toEqual(["CyclicA"]);

    // Assert diamond convergence
    expect(await service.getBacklinks("DiamLeaf")).toEqual(["DiamLeft", "DiamRight"]);
    expect(await service.getBacklinks("DiamLeft")).toEqual(["DiamRoot"]);
    expect(await service.getBacklinks("DiamRight")).toEqual(["DiamRoot"]);

    // Assert isolated node has no backlinks
    expect(await service.getBacklinks("Island")).toEqual([]);

    // Assert ghost note in cyclic structure
    const ghosts = await service.getGhostNotes();
    expect(ghosts.find((g) => g.targetTitle === "UnauthoredGhost")).toEqual({
      targetTitle: "UnauthoredGhost",
      referencedBy: ["CyclicB"],
    });
  });
});
