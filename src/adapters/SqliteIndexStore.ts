import { DatabaseSync } from "node:sqlite";
import type { IndexStore, NoteMetadata, NoteRecord } from "../ports/IndexStore.js";

export class SqliteIndexStore implements IndexStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string = ":memory:") {
    this.db = new DatabaseSync(databasePath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        title TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tags (
        note_title TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (note_title, tag),
        FOREIGN KEY (note_title) REFERENCES notes(title) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    `);
  }

  async upsertNote(record: NoteRecord): Promise<void> {
    const upsertStmt = this.db.prepare(`
      INSERT INTO notes (title, file_path, mtime, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(title) DO UPDATE SET
        file_path = excluded.file_path,
        mtime = excluded.mtime,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    const deleteTagsStmt = this.db.prepare(`
      DELETE FROM tags WHERE note_title = ?
    `);

    const insertTagStmt = this.db.prepare(`
      INSERT OR IGNORE INTO tags (note_title, tag) VALUES (?, ?)
    `);

    upsertStmt.run(
      record.title,
      record.filePath,
      record.mtime,
      record.createdAt ?? null,
      record.updatedAt ?? null
    );

    deleteTagsStmt.run(record.title);

    for (const tag of record.tags) {
      const normalizedTag = tag.trim();
      if (normalizedTag.length > 0) {
        insertTagStmt.run(record.title, normalizedTag);
      }
    }
  }

  async deleteNote(title: string): Promise<boolean> {
    const stmt = this.db.prepare("DELETE FROM notes WHERE title = ?");
    const result = stmt.run(title);
    return Number(result.changes) > 0;
  }

  async searchByTag(tag: string): Promise<string[]> {
    const stmt = this.db.prepare(`
      SELECT note_title FROM tags WHERE tag = ? ORDER BY note_title ASC
    `);
    const rows = stmt.all(tag.trim()) as Array<{ note_title: string }>;
    return rows.map((row) => row.note_title);
  }

  async getNoteMetadata(title: string): Promise<NoteMetadata | null> {
    const noteStmt = this.db.prepare(`
      SELECT title, file_path, mtime, created_at, updated_at
      FROM notes WHERE title = ?
    `);
    const noteRow = noteStmt.get(title) as
      | {
          title: string;
          file_path: string;
          mtime: number;
          created_at: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!noteRow) {
      return null;
    }

    const tagStmt = this.db.prepare(`
      SELECT tag FROM tags WHERE note_title = ? ORDER BY tag ASC
    `);
    const tagRows = tagStmt.all(title) as Array<{ tag: string }>;
    const tags = tagRows.map((r) => r.tag);

    return {
      title: noteRow.title,
      filePath: noteRow.file_path,
      mtime: Number(noteRow.mtime),
      createdAt: noteRow.created_at ?? undefined,
      updatedAt: noteRow.updated_at ?? undefined,
      tags,
    };
  }

  async listAllIndexedTitles(): Promise<string[]> {
    const stmt = this.db.prepare("SELECT title FROM notes ORDER BY title ASC");
    const rows = stmt.all() as Array<{ title: string }>;
    return rows.map((r) => r.title);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
