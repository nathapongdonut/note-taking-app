# SQLite Embedded Metadata Index

We maintain an embedded SQLite database as a read-optimized Index of Note metadata, tags, and Wiki-link relationships, while preserving raw Markdown files as the canonical source of truth. This avoids slow full-vault filesystem scans on every search or link query, trading off the requirement to synchronize the index upon file changes.
