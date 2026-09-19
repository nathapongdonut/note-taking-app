export interface NoteFrontmatter {
  title?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface Note {
  title: string;
  frontmatter: NoteFrontmatter;
  tags: string[];
  body: string;
}
