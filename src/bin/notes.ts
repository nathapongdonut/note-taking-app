#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";
import { KnowledgeBaseService } from "../application/KnowledgeBaseService.js";
import { runCli } from "../cli/runCli.js";

async function main() {
  const vaultDir = process.env.NOTES_VAULT || path.join(process.cwd(), "vault");
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true });
  }

  const dbPath = process.env.NOTES_DB || path.join(vaultDir, ".notes-index.sqlite");
  const noteRepo = new FsNoteRepository(vaultDir);
  const indexStore = new SqliteIndexStore(dbPath);
  const service = new KnowledgeBaseService(noteRepo, indexStore);

  try {
    const exitCode = await runCli(process.argv.slice(2), service);
    await indexStore.close();
    process.exit(exitCode);
  } catch (err) {
    await indexStore.close();
    console.error(err);
    process.exit(1);
  }
}

main();
