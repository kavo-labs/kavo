# Field selection

```http
GET /books?select=id,title
```

`select` picks a sparse fieldset for the root resource, validated against the `selectable` allowlist. Narrow an included relation the same way: `select[author]=id,name`.

`selectable` also decides what a response carries when no `select=` is sent. It's the one place to keep a column out of every response. See [Allowed](/features/allowed).
