# Filtering

```
GET /books?filter[title][eq]=Dune
```

`filter[<field>][<operator>]=<value>`. Multiple `filter[...]` params AND together implicitly, and multiple operators on the same field also AND:

```
GET /books?filter[pages][gte]=200&filter[pages][lt]=500
```

| Operator              | Wire token   | Example                                            |
| --------------------- | ------------ | -------------------------------------------------- |
| Equals                | `eq`         | `filter[status][eq]=active`                        |
| Not equals            | `ne`         | `filter[status][ne]=banned`                        |
| Greater/equal         | `gt` / `gte` | `filter[age][gte]=18`                              |
| Less/equal            | `lt` / `lte` | `filter[age][lt]=65`                               |
| In list               | `in`         | `filter[status][in]=active,pending`                |
| Not in list           | `notIn`      | `filter[role][notIn]=bot,test`                     |
| Like                  | `like`       | `filter[name][like]=%25john%25`                    |
| Case-insensitive like | `ilike`      | `filter[name][ilike]=%25john%25`                   |
| Between               | `between`    | `filter[createdAt][between]=2026-01-01,2026-06-01` |
| Is null               | `isNull`     | `filter[deletedAt][isNull]=true`                   |
| Is not null           | `isNotNull`  | `filter[deletedAt][isNotNull]=true`                |

Wire tokens are exact-case (`gte`, not `GTE`) — a misspelled or wrong-case operator is a 400, not silently ignored. `like`/`ilike` never auto-wrap wildcards; pass `%` yourself, and escape any literal `%`/`_` in the value with a backslash. Both apply to string columns only.

`in`/`notIn` also accept the repeated-key form instead of a comma list:

```
GET /books?filter[status][in][]=active&filter[status][in][]=pending
```

`between` takes exactly two comma-separated bounds. `isNull`/`isNotNull` are boolean-valued — `isNull=false` means the same thing as `isNotNull=true`, so pick whichever reads better.

Only fields on the entity's `filterable` allowlist can be filtered on — see [Allowlists & computed fields](/features/allowlists-and-computed-fields#allowlists) for how to configure that list. Anything outside it is a 400, never a silent no-op.

**OR / NOT / nested logic** uses the same bracket grammar and can be nested arbitrarily deep (up to `query.maxFilterDepth`, default 3):

```
GET /books?filter[or][0][author][eq]=Tolkien&filter[or][1][author][eq]=Herbert
GET /books?filter[not][status][eq]=banned
```

For anything the bracket grammar gets awkward at, `filter` also accepts one JSON-encoded value as a full-power escape hatch — it parses into the same filter tree as the bracket form, and if both are present on a request, they AND together:

```
GET /books?filter={"or":[{"author":{"eq":"Tolkien"}},{"not":{"status":{"eq":"banned"}}}]}
```

**Relation-path filtering** uses dot notation and restricts root rows without loading the related collection — it never filters _what's inside_ an included relation, only which root rows come back:

```
GET /books?filter[author.country][eq]=UK
```

**Limits** guard every request, configurable per scope: `query.maxFilterDepth` (default 3) caps how deeply `or`/`not` can nest, `query.maxInValues` (default 100) caps `in`/`notIn` array length, and `pagination.maxLimit` (default 100) caps page size. Filter/sort/fields/pagination violations on one request are collected together and reported in a single response — see [Errors](/using-the-api#errors).
