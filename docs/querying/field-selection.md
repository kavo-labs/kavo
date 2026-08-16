# Field selection

```http
GET /books?fields=id,title
```

`fields` picks a sparse fieldset for the root resource, validated against the `selectable` allowlist. Narrow an included relation the same way: `fields[author]=id,name`.

`selectable` also decides what a response carries when no `fields=` is sent. It's the one place to keep a column out of every response. See [Allowlists](/features/allowlists).
