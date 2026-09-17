# ADR-0019 — Computed fields are serializer-evaluated, and never filterable, sortable, or writable

**Status:** superseded by [ADR-0050](/internals/adr/0050-derived-fields-come-from-orm-metadata) — `computed` (`ComputedFieldDescriptor`/`ComputedFieldMap`, `EntityConfig.computed`) is removed; a derived field is now declared through the ORM's own virtual/generated-column mechanism instead. See ADR-0050 for the current design.
