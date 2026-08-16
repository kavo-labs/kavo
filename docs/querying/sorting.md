# Sorting

```http
GET /books?sort=-publishedAt,title
```

`sort` takes a comma-separated field list. A `-` prefix means descending, and the order of the fields sets the priority order. Only fields on the `sortable` allowlist can be used.

If a request supplies no `sort` at all, the entity's configured `query.defaultSort` applies, if it has one. A client-supplied `sort` always wins outright over that default. It doesn't merge with it.
