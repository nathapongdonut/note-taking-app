import { DatabaseSync } from "node:sqlite";
import type { GhostNoteRecord, IndexStore, NoteMetadata, NoteRecord } from "../ports/IndexStore.js";

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
        FOREIGN KEY (note_title) REFERENCES notes(title) ON UPDATE CASCADE ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

      CREATE TABLE IF NOT EXISTS links (
        source_title TEXT NOT NULL,
        target_title TEXT NOT NULL,
        PRIMARY KEY (source_title, target_title),
        FOREIGN KEY (source_title) REFERENCES notes(title) ON UPDATE CASCADE ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_title);
      CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_title);
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

    const deleteLinksStmt = this.db.prepare(`
      DELETE FROM links WHERE source_title = ?
    `);

    const insertLinkStmt = this.db.prepare(`
      INSERT OR IGNORE INTO links (source_title, target_title) VALUES (?, ?)
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

    deleteLinksStmt.run(record.title);

    if (record.links) {
      for (const link of record.links) {
        const normalizedLink = link.trim();
        if (normalizedLink.length > 0) {
          insertLinkStmt.run(record.title, normalizedLink);
        }
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

    const linkStmt = this.db.prepare(`
      SELECT target_title FROM links WHERE source_title = ? ORDER BY target_title ASC
    `);
    const linkRows = linkStmt.all(title) as Array<{ target_title: string }>;
    const links = linkRows.map((r) => r.target_title);

    return {
      title: noteRow.title,
      filePath: noteRow.file_path,
      mtime: Number(noteRow.mtime),
      createdAt: noteRow.created_at ?? undefined,
      updatedAt: noteRow.updated_at ?? undefined,
      tags,
      links,
    };
  }

  async getOutboundLinks(title: string): Promise<string[]> {
    const stmt = this.db.prepare(`
      SELECT target_title FROM links WHERE source_title = ? ORDER BY target_title ASC
    `);
    const rows = stmt.all(title.trim()) as Array<{ target_title: string }>;
    return rows.map((r) => r.target_title);
  }

  async getBacklinks(title: string): Promise<string[]> {
    const stmt = this.db.prepare(`
      SELECT source_title FROM links WHERE target_title = ? ORDER BY source_title ASC
    `);
    const rows = stmt.all(title.trim()) as Array<{ source_title: string }>;
    return rows.map((r) => r.source_title);
  }

  async getGhostNotes(): Promise<GhostNoteRecord[]> {
    const stmt = this.db.prepare(`
      SELECT target_title, source_title
      FROM links
      WHERE target_title NOT IN (SELECT title FROM notes)
      ORDER BY target_title ASC, source_title ASC
    `);
    const rows = stmt.all() as Array<{ target_title: string; source_title: string }>;

    const ghostMap = new Map<string, string[]>();
    for (const row of rows) {
      let list = ghostMap.get(row.target_title);
      if (!list) {
        list = [];
        ghostMap.set(row.target_title, list);
      }
      list.push(row.source_title);
    }

    return Array.from(ghostMap.entries()).map(([targetTitle, referencedBy]) => ({
      targetTitle,
      referencedBy,
    }));
  }

  async listAllIndexedTitles(): Promise<string[]> {
    const stmt = this.db.prepare("SELECT title FROM notes ORDER BY title ASC");
    const rows = stmt.all() as Array<{ title: string }>;
    return rows.map((r) => r.title);
  }

  async renameNote(oldTitle: string, newTitle: string): Promise<void> {
    const trimmedOld = oldTitle.trim();
    const trimmedNew = newTitle.trim();

    if (!trimmedOld || !trimmedNew) {
      throw new Error("Note title cannot be empty.");
    }

    if (trimmedOld === trimmedNew) {
      return;
    }

    const checkOldStmt = this.db.prepare("SELECT title, file_path FROM notes WHERE title = ?");
    const oldRecord = checkOldStmt.get(trimmedOld) as { title: string; file_path: string } | undefined;
    if (!oldRecord) {
      throw new Error(`Cannot rename note: "${trimmedOld}" does not exist in the index.`);
    }

    const checkNewStmt = this.db.prepare("SELECT title FROM notes WHERE title = ?");
    const newExists = checkNewStmt.get(trimmedNew);
    if (newExists) {
      throw new Error(`Cannot rename note: "${trimmedNew}" already exists in the index.`);
    }

    this.db.exec("BEGIN TRANSACTION;");
    try {
      // 1. Update inbound links: target_title = trimmedOld -> trimmedNew
      this.db
        .prepare("UPDATE OR IGNORE links SET target_title = ? WHERE target_title = ?")
        .run(trimmedNew, trimmedOld);
      this.db.prepare("DELETE FROM links WHERE target_title = ?").run(trimmedOld);

      // 2. Update notes table, which cascades source_title in links and note_title in tags
      const nowIso = new Date().toISOString();
      const nowMtime = Date.now();
      const oldPath = oldRecord.file_path;
      const lastSlash = Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\"));
      const newFilePath =
        lastSlash >= 0
          ? `${oldPath.slice(0, lastSlash + 1)}${trimmedNew}.md`
          : `${trimmedNew}.md`;

      this.db
        .prepare("UPDATE notes SET title = ?, file_path = ?, mtime = ?, updated_at = ? WHERE title = ?")
        .run(trimmedNew, newFilePath, nowMtime, nowIso, trimmedOld);

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
