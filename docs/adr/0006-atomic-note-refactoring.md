# Atomic Note Refactoring with Compensating Rollback

Because atomic transactions spanning both the local filesystem and SQLite do not exist, we encapsulate the multi-file rewrite workflow in a dedicated application `RefactorService` that drives a LIFO compensating rollback stack. This ensures that any disk I/O or SQLite error during note renaming or Wiki-link updates automatically unrolls prior mutations to maintain consistency between Markdown files and the SQLite index without requiring filesystem locks or staging directories.
