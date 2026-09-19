export interface NoteRecord {
  title: string;
  filePath: string;
  mtime: number;
  createdAt?: string;
  updatedAt?: string;
  tags: string[];
}

export interface NoteMetadata {
  title: string;
  filePath: string;
  mtime: number;
  createdAt?: string;
  updatedAt?: string;
  tags: string[];
}

/**
 * Port interface for indexing and fast querying of Note metadata and tags.
 */
export interface IndexStore {
  /**
   * Inserts or updates a Note's metadata and synchronizes its tags in the index.
   */
  upsertNote(record: NoteRecord): Promise<void>;

  /**
   * Deletes a Note from the index and cascades deletion of its tags.
   */
  deleteNote(title: string): Promise<boolean>;

  /**
   * Searches the index for all note titles matching a given tag.
   */
  searchByTag(tag: string): Promise<string[]>;

  /**
   * Retrieves the indexed metadata and tags for a note.
   */
  getNoteMetadata(title: string): Promise<NoteMetadata | null>;

  /**
   * Lists all note titles currently recorded in the index.
   */
  listAllIndexedTitles(): Promise<string[]>;

  /**
   * Closes the index connection.
   */
  close(): Promise<void>;
}
