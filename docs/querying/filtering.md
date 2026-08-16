# Filtering

```http
GET /books?filter[title][eq]=Dune
```

The general form is `filter[<field>][<operator>]=<value>`. Multiple `filter[...]` params AND together, and multiple operators on the same field also AND together:

```http
GET /books?filter[pages][gte]=200&filter[pages][lt]=500
```

## Operators

| Operator              | Wire token   | Example                                            |
| ---------------------- | ------------ | --------------------------------------------------- |
| Equals                 | `eq`         | `filter[status][eq]=active`                         |
| Not equals              | `ne`         | `filter[status][ne]=banned`                         |
| Greater/equal          | `gt` / `gte` | `filter[age][gte]=18`                                |
| Less/equal             | `lt` / `lte` | `filter[age][lt]=65`                                 |
| In list                | `in`         | `filter[status][in]=active,pending`                  |
| Not in list             | `notIn`      | `filter[role][notIn]=bot,test`                       |
| Like                   | `like`       | `filter[name][like]=%25john%25`                      |
| Case-insensitive like   | `ilike`      | `filter[name][ilike]=%25john%25`                     |
| Between                | `between`    | `filter[createdAt][between]=2026-01-01,2026-06-01`   |
| Is null                | `isNull`     | `filter[deletedAt][isNull]=true`                     |
| Is not null             | `isNotNull`  | `filter[deletedAt][isNotNull]=true`                  |

Wire tokens are exact case, so `gte` works but `GTE` does not. A misspelled or wrong-case operator returns a 400 instead of being silently ignored.

`like` and `ilike` never auto-wrap wildcards: pass `%` yourself, and escape any literal `%` or `_` in the value with a backslash. Both apply to string columns only.

`in` and `notIn` also accept the repeated-key form instead of a comma list:

```http
GET /books?filter[status][in][]=active&filter[status][in][]=pending
```

`between` takes exactly two comma-separated bounds. `isNull` and `isNotNull` are boolean-valued: `isNull=false` means the same thing as `isNotNull=true`, so pick whichever reads better.

## Which fields you can filter on

Only fields on the entity's `filterable` allowlist can be filtered on. See [Allowlists](/features/allowlists) for how to configure that list. Filtering on anything outside it returns a 400, never a silent no-op.

## OR, NOT, and nested logic

The same bracket grammar covers `or` and `not`, and it can nest arbitrarily deep, up to `query.maxFilterDepth` (default 3):

```http
GET /books?filter[or][0][author][eq]=Tolkien&filter[or][1][author][eq]=Herbert
GET /books?filter[not][status][eq]=banned
```

For anything the bracket grammar gets awkward at, `filter` also accepts one JSON-encoded value as a full-power escape hatch. It parses into the same filter tree as the bracket form. If both are present on a request, they AND together:

```http
GET /books?filter={"or":[{"author":{"eq":"Tolkien"}},{"not":{"status":{"eq":"banned"}}}]}
```

## Filtering across relations

Relation-path filters use dot notation and restrict root rows, without loading the related collection:

```http
GET /books?filter[author.country][eq]=UK
```

This never filters what's inside an included relation. It only decides which root rows come back.

## Limits

Every request is guarded by limits, configurable per scope:

- `query.maxFilterDepth` (default 3) caps how deeply `or`/`not` can nest.
- `query.maxInValues` (default 100) caps `in`/`notIn` array length.
- `pagination.maxLimit` (default 100) caps page size.

If a request breaks several of these at once (filter, sort, fields, pagination), Kavo collects the violations and reports them together in a single response. See [Errors](/using-the-api#errors).
