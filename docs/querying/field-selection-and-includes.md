# Field selection & includes

## Field selection

```http
GET /books?fields=id,title
```

Sparse fieldset for the root resource, validated against the `selectable` allowlist. Narrow an included relation the same way: `fields[author]=id,name`.

`selectable` also decides what a response carries when no `fields=` is sent, so it is the one place to keep a column out of every response — see [Allowlists](/features/allowlists-and-computed-fields#allowlists).

## Includes

```http
GET /books?include=author,reviews.user
```

Comma-separated dot-paths, merged into one tree. Only relations the entity marks `includable` (see [Relations](/features/relations)) can appear here — an un-includable or misspelled relation is a 400.
