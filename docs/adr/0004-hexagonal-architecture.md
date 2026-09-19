# Hexagonal Architecture (Ports and Adapters)

We structure the codebase using Hexagonal Architecture, isolating the core domain logic (Note entities, Wiki-link parsing, Graph traversal, Refactoring) from technical infrastructure (Node.js filesystem I/O, SQLite, CLI formatting). This trades higher upfront interface boilerplate for total testability—allowing comprehensive domain testing with in-memory test doubles without touching disk or databases—and decouples business logic from external frameworks.
