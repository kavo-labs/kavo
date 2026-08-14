# Sorting

```http
GET /books?sort=-publishedAt,title
```

Comma-separated field list, `-` prefix for descending, order = priority order. Only fields on the `sortable` allowlist are usable. If a request supplies no `sort` at all, the entity's configured `query.defaultSort` (if any) applies — a client-supplied `sort` always wins outright over that default rather than merging with it.
