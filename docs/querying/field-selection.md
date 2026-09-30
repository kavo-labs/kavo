# Field selection

```http
GET /books?select=id,title
```

`select` picks a sparse fieldset for the root resource, validated against the `select.fields` allowlist. Narrow an included relation the same way: `select[author]=id,name`.

`select.fields` also decides what a response carries when no `select=` is sent — unless the entity configures `select.default`, a narrower default projection applied only when the request sends no `select=` of its own (a client-supplied `select=` always wins outright, same as `sort.default`). `select.fields` is the one place to keep a column out of every response, regardless of `select.default`. A registered class-shaped output schema with a runtime shape (`schema.output.item`/`list`, or an operation's own `schema.output`) caps `select.default` the same way: a default field the schema omits is dropped, never served, and a default that shares no field with it fails at bootstrap. See [Allowed](/features/allowed) and [Config keys](/reference/config-keys#select).
