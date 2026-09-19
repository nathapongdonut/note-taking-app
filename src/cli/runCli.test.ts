import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCli, type CliIo } from "./runCli.js";
import { KnowledgeBaseService } from "../application/KnowledgeBaseService.js";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";

describe("CLI Adapter (runCli)", () => {
  let tempVaultDir: string;
  let service: KnowledgeBaseService;
  let indexStore: SqliteIndexStore;
  let logs: string[];
  let errors: string[];
  let io: CliIo;

  beforeEach(async () => {
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-"));
    const noteRepo = new FsNoteRepository(tempVaultDir);
    indexStore = new SqliteIndexStore(":memory:");
    service = new KnowledgeBaseService(noteRepo, indexStore);

    logs = [];
    errors = [];
    io = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    };
  });

  afterEach(async () => {
    await indexStore.close();
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  it("handles 'create' command and creates a note with tags", async () => {
    const exitCode = await runCli(
      ["create", "Cardiology", "--body", "Heart anatomy and diseases.", "--tags", "medicine,cardio"],
      service,
      io
    );

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('Created note "Cardiology"'))).toBe(true);

    // Verify it was persisted on disk and indexed
    const note = await service.getNote("Cardiology");
    expect(note?.body).toBe("Heart anatomy and diseases.");
    expect(note?.tags).toEqual(["medicine", "cardio"]);
  });

  it("handles 'view' command and displays note details", async () => {
    await service.createNote({
      title: "Neurology",
      body: "Brain overview.",
      tags: ["neuro"],
    });

    const exitCode = await runCli(["view", "Neurology"], service, io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Title: Neurology"))).toBe(true);
    expect(logs.some((l) => l.includes("Brain overview."))).toBe(true);
  });

  it("returns error code and message when viewing a non-existent note", async () => {
    const exitCode = await runCli(["view", "NonExistent"], service, io);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes('Note "NonExistent" not found.'))).toBe(true);
  });

  it("handles 'search --tag' command and lists matching notes", async () => {
    await service.createNote({
      title: "Asthma",
      body: "Airway inflammation",
      tags: ["pulmonary", "chronic"],
    });
    await service.createNote({
      title: "COPD",
      body: "Chronic obstructive lung disease",
      tags: ["pulmonary", "chronic"],
    });

    const exitCode = await runCli(["search", "--tag", "pulmonary"], service, io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Asthma"))).toBe(true);
    expect(logs.some((l) => l.includes("COPD"))).toBe(true);
  });

  it("outputs appropriate message when search finds no matching tags", async () => {
    const exitCode = await runCli(["search", "--tag", "nonexistent"], service, io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('No notes found with tag "nonexistent"'))).toBe(true);
  });

  it("returns error for unknown command", async () => {
    const exitCode = await runCli(["unknownCommand"], service, io);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Unknown command"))).toBe(true);
  });
});
