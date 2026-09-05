# Field selection

```http
GET /books?select=id,title
```

`select` picks a sparse fieldset for the root resource, validated against the `selectable` allowlist. Narrow an included relation the same way: `select[author]=id,name`.

`selectable` also decides what a response carries when no `select=` is sent — unless the entity configures `defaults.select`, a narrower default projection applied only when the request sends no `select=` of its own (a client-supplied `select=` always wins outright, same as `defaults.sort`). `selectable` is the one place to keep a column out of every response, regardless of `defaults.select`. See [Allowed](/features/allowed) and [Settings](/guides/configuration/settings#defaults).
