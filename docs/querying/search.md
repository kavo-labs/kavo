# Search

```http
GET /books?search[query]=dune
```

`search[query]=<term>` is free-text search across a set of fields. That's different from `filter[...]`, which matches a single field. Search composes with any `filter[...]` already on the request (they AND together) instead of replacing it.

Search is off by default per entity (`query.search` is `false`): a plain 400 until a scope turns it on by setting `query.search` to an object.

```ts
@Kavo(Book, { query: { search: {} } }) // `{ mode: "substring", driver: "orm" }` — the defaults
```

Set `query.search` back to `false` at a narrower scope (an entity or an operation) to disable it there. It only searches fields on the entity's `searchable` allowlist (default: every own string column). See [Allowlists](/features/allowlists).

```http
GET /books?search[query]=blue+iphone&search[mode]=words&search[fields]=title,description
```

- `search[mode]=substring` (default) matches the whole term as a substring in any searched field. `search[mode]=words` splits the term on whitespace and requires every word to match somewhere, independently.
- `search[fields]=<comma-list>` narrows the search to a subset of the entity's `searchable` allowlist for this request. A name outside that allowlist is a 400.
- A literal `%` or `_` in the term is matched literally, never as a SQL wildcard. You don't need to escape it yourself.
