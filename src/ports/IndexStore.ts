export interface NoteRecord {
  title: string;
  filePath: string;
  mtime: number;
  createdAt?: string;
  updatedAt?: string;
  tags: string[];
  links?: string[];
}

export interface NoteMetadata {
  title: string;
  filePath: string;
  mtime: number;
  createdAt?: string;
  updatedAt?: string;
  tags: string[];
  links?: string[];
}

export interface GhostNoteRecord {
  targetTitle: string;
  referencedBy: string[];
}

/**
 * Port interface for indexing and fast querying of Note metadata, tags, and link relationships.
 */
export interface IndexStore {
  /**
   * Inserts or updates a Note's metadata and synchronizes its tags and outbound links in the index.
   */
  upsertNote(record: NoteRecord): Promise<void>;

  /**
   * Deletes a Note from the index and cascades deletion of its tags and outbound links.
   */
  deleteNote(title: string): Promise<boolean>;

  /**
   * Searches the index for all note titles matching a given tag.
   */
  searchByTag(tag: string): Promise<string[]>;

  /**
   * Retrieves the indexed metadata, tags, and outbound links for a note.
   */
  getNoteMetadata(title: string): Promise<NoteMetadata | null>;

  /**
   * Retrieves all outbound Wiki-link targets from a note.
   */
  getOutboundLinks(title: string): Promise<string[]>;

  /**
   * Retrieves all incoming Backlinks (notes that contain a Wiki-link to this title).
   */
  getBacklinks(title: string): Promise<string[]>;

  /**
   * Retrieves all Ghost Notes (concepts referenced via Wiki-links that do not exist as authored notes in the Vault).
   */
  getGhostNotes(): Promise<GhostNoteRecord[]>;

  /**
   * Lists all note titles currently recorded in the index.
   */
  listAllIndexedTitles(): Promise<string[]>;

  /**
   * Renames an indexed note and cascades changes to tags and link edges.
   */
  renameNote(oldTitle: string, newTitle: string): Promise<void>;

  /**
   * Retrieves metadata for all indexed notes.
   */
  getAllNotesMetadata(): Promise<NoteMetadata[]>;

  /**
   * Closes the index connection.
   */
  close(): Promise<void>;
}
