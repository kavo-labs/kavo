# Search

```http
GET /books?search[query]=dune
```

`search[query]=<term>` is free-text search across a set of fields, as
opposed to `filter[...]`'s single-field predicates. It composes with any
`filter[...]` already on the request (`AND`-ed together) rather than
replacing it. It's off by default per entity — a plain 400 if the entity
hasn't turned `query.search.enabled` on — and only searches fields on the
entity's `searchable` allowlist (default: every own string column) — see
[Allowlists & computed fields](/features/allowlists-and-computed-fields#allowlists).

```http
GET /books?search[query]=blue+iphone&search[mode]=words&search[fields]=title,description
```

- `search[mode]=substring` (default) matches the whole term as a substring
  in any searched field; `search[mode]=words` splits the term on
  whitespace and requires every word to match somewhere, independently.
- `search[fields]=<comma-list>` narrows the search to a subset of the
  entity's `searchable` allowlist for this request; a name outside that
  allowlist is a 400.
- A literal `%` or `_` in the term is matched literally, never as a SQL
  wildcard — no need to escape it yourself.
