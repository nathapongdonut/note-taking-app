# Local Markdown File Storage

We store notes as plain Markdown files with YAML frontmatter directly on the local filesystem rather than in a centralized database or cloud service. This ensures user ownership, zero infrastructure overhead, and portability, trading off relational query performance which we will address via an in-memory or SQLite index layer.
