import type { Note } from "../domain/Note.js";

export interface NoteFileInfo {
  title: string;
  filePath: string;
  mtime: number;
}

/**
 * Port interface for storing and retrieving Notes.
 * Implementation adapters handle physical persistence (Filesystem, Cloud, In-Memory, etc.).
 */
export interface NoteRepository {
  /**
   * Persists a Note to storage.
   */
  save(note: Note): Promise<void>;

  /**
   * Retrieves a Note by its title, or returns null if not found.
   */
  get(title: string): Promise<Note | null>;

  /**
   * Deletes a Note by its title. Returns true if deleted, false if not found.
   */
  delete(title: string): Promise<boolean>;

  /**
   * Lists all existing Note titles in the Vault.
   */
  listTitles(): Promise<string[]>;

  /**
   * Checks whether a Note with the given title exists.
   */
  exists(title: string): Promise<boolean>;

  /**
   * Renames a Note from an old title to a new title in storage.
   */
  rename(oldTitle: string, newTitle: string): Promise<void>;

  /**
   * Retrieves physical file information including mtime for a note.
   */
  getFileInfo(title: string): Promise<NoteFileInfo | null>;

  /**
   * Lists physical file information including mtime for all notes in the Vault.
   */
  listAllFiles(): Promise<NoteFileInfo[]>;
}
