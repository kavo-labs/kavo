# Virtual fields

How to expose a field that has no ordinary storage column, using the ORM's own virtual/generated-column mechanism.

A response can carry a field with nothing behind it in the base table — a `fullName` built from two columns, a per-row relation count, a formatted total. Kavo does not define these itself (see [ADR-0050](/internals/adr/0050-derived-fields-come-from-orm-metadata) for why): it reads whatever your ORM already has a mechanism for, and treats the result as a field like any other, wherever the ORM's own query builder can make that true.

```ts
@Entity()
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  year!: number;

  @VirtualColumn({ query: (alias) => `${alias}.title || ' (' || ${alias}.year || ')'` })
  displayTitle!: string;
}
```

```
GET /books/1               → { "id": 1, "title": "Dune", "year": 1965, "displayTitle": "Dune (1965)" }
GET /books?select=id,displayTitle
```

A field with a `derivedExpression` in its ORM metadata is **opt-in** to `filterable`/`sortable`/`selectable`, the same rule a relation follows: the unconfigured default excludes it, and naming it explicitly is what opens it up.

```ts
@Kavo(Book, {
  select: { fields: ["id", "title", "year", "displayTitle"] },
})
```

Whether a filter or sort on the field actually works — not just typechecks — depends on the ORM: `@kavo/typeorm` and `@kavo/mikroorm` inline the expression into `WHERE`/`ORDER BY`; `@kavo/prisma` and `@kavo/mongoose` have no such mechanism, so their derived fields are response-only, and the field is invisible to the query engine entirely (naming it in `filter.fields`/`sort.fields`/`select.fields` there is a bootstrap error the same way naming a nonexistent column would be). See the support matrix below.

## (a) A simple response-only virtual

The field never needs filtering or sorting — a formatted display value, a caller-facing label. Every ORM can do this; the mechanism differs.

::: code-group

```ts [TypeORM]
@Entity()
class Book {
  // ...
  @VirtualColumn({ query: (alias) => `${alias}.title || ' (' || ${alias}.year || ')'` })
  displayTitle!: string;
}
```

```ts [MikroORM]
@Entity()
class Book {
  // ...
  @Property({ formula: (cols) => `${cols.title} || ' (' || ${cols.year} || ')'` })
  displayTitle!: string;
}
```

```ts [Prisma]
const prisma = new PrismaClient().$extends({
  result: {
    book: {
      displayTitle: {
        needs: { title: true, year: true },
        compute(book) {
          return `${book.title} (${book.year})`;
        },
      },
    },
  },
});
```

```ts [Mongoose]
const BookSchema = new Schema({ title: String, year: Number });
BookSchema.virtual("displayTitle").get(function () {
  return `${this.title} (${this.year})`;
});
```

:::

**TypeORM has a second, decorator-free way: a plain class getter**, because its QueryBuilder hands back real entity class instances rather than plain objects:

```ts
@Entity()
class Book {
  // ...
  get displayTitle(): string {
    return `${this.title} (${this.year})`;
  }
}
```

A getter carries no `FieldMetadata` at all — there is nothing to opt into `filter.fields`/`sort.fields`/`select.fields`, and it is unconditionally response-only. It reaches a response only through a registered DTO that names it (the DTO's own initializer value is unused; `DefaultSerializer` reads the real value off the entity instance, which is what invokes the getter):

```ts
class BookItemDto {
  id = 0;
  displayTitle = ""; // registers the key; the getter supplies the value
}
@Kavo(Book, { dto: { item: BookItemDto } })
```

This only works on TypeORM. `@kavo/mikroorm` and `@kavo/mongoose` both convert an ORM row to a plain object at the adapter boundary before core ever sees it (`wrap(entity).toObject()`, `document.toObject({ getters: false, virtuals: false })`), which strips a plain getter or an unconfigured virtual either way; `@kavo/prisma` never has a class instance to put a getter on in the first place.

The TypeORM and MikroORM forms are `FieldMetadata` entries Kavo sees and can serve through the ordinary `select=`/DTO path with no further configuration beyond opting them into `select.fields`. The Prisma and Mongoose forms are invisible to Kavo's metadata seam entirely — they exist only on the client's returned object — so surfacing one over HTTP means registering an explicit `item`/`list` DTO that names it, or a custom operation that reads the extended client / virtual directly.

## (b) A filterable/sortable SQL-expression virtual

Only worth it when the ORM can push the expression into `WHERE`/`ORDER BY` — TypeORM and MikroORM here, not Prisma or Mongoose.

::: code-group

```ts [TypeORM]
@Entity()
class Book {
  // ...
  @VirtualColumn({ query: (alias) => `LOWER(${alias}.title)` })
  titleLower!: string;
}
```

```ts [MikroORM]
@Entity()
class Book {
  // ...
  @Property({ formula: (cols) => `LOWER(${cols.title})` })
  titleLower!: string;
}
```

:::

```ts
@Kavo(Book, {
  filter: { fields: ["titleLower"] },
  sort: { fields: ["titleLower"] },
  select: { fields: ["id", "title", "titleLower"] },
})
```

```
GET /books?filter[titleLower][eq]=dune&sort=titleLower
```

`search.fields` is the one field-group a derived field can never join, opted in or not — there is no ORM-independent way to turn an arbitrary derived expression into a `WHERE ... ILIKE` fragment.

## (c) An aggregation-style virtual (relation count)

A per-row aggregate — "how many comments does this post have" — is just a correlated-subquery `@VirtualColumn`/`@Formula`, not a separate Kavo feature (aggregation as a bucketed `GROUP BY` endpoint is a different, still-unbuilt shape of problem, tracked separately).

::: code-group

```ts [TypeORM]
@Entity()
class Post {
  // ...
  @VirtualColumn({
    query: (alias) => `SELECT COUNT(*) FROM comment WHERE comment.postId = ${alias}.id`,
  })
  commentCount!: number;
}
```

```ts [MikroORM]
@Entity()
class Post {
  // ...
  @Property({
    formula: (cols, table) => `(SELECT COUNT(*) FROM comment WHERE comment.post_id = ${table}.id)`,
  })
  commentCount!: number;
}
```

:::

```ts
@Kavo(Post, {
  filter: { fields: ["commentCount"] },
  sort: { fields: ["commentCount"] },
  select: { fields: ["id", "title", "commentCount"] },
})
```

```
GET /posts?sort=-commentCount        → most-commented first
GET /posts?filter[commentCount][gt]=10
```

## Support matrix

| ORM                                              | Response-only                                                                          | Filterable / sortable                                        | Selectable (opt-in)     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------- |
| `@kavo/typeorm` (`@VirtualColumn`)               | ✅                                                                                     | ✅ (inlined into `WHERE`/`ORDER BY`)                         | ✅                      |
| `@kavo/mikroorm` (`@Formula`)                    | ✅                                                                                     | ✅ (MikroORM resolves the formula by property name natively) | ✅                      |
| `@kavo/prisma` (client extension `result` field) | ✅ (via a registered DTO or custom operation only — invisible to Kavo's metadata seam) | ❌ (400, unknown field)                                      | ❌ (400, unknown field) |
| `@kavo/mongoose` (`schema.virtual`)              | ✅ (via a registered DTO or custom operation only — invisible to Kavo's metadata seam) | ❌ (400, unknown field)                                      | ❌ (400, unknown field) |

## What changed from `computed` (ADR-0019)

Prior to issue #373, a virtual field was declared through `@Kavo(Entity, { computed: { name: { resolve } } })` — a JavaScript function evaluated per served row, response-only by construction. That feature is **removed**, not deprecated: `computed`, `ComputedFieldDescriptor`, and `ComputedFieldMap` no longer exist. Migrate a `computed` declaration by moving its logic into the ORM:

- A pure, column-derived value (`fullName`, `displayTitle`) → a `@VirtualColumn`/`@Formula`/client-extension field/schema virtual, per your ORM, as above.
- A value that needs to be filtered or sorted → the same, on TypeORM or MikroORM only.
- **A value that varied by caller** (`context.app`) has no replacement. An ORM-derived expression is evaluated by the database once per row; nothing about it can vary by the request reading the row. Reach for a custom operation, an explicit `item`/`list` DTO computed in application code, or a policy instead.

See [ADR-0050](/internals/adr/0050-derived-fields-come-from-orm-metadata) for the full design and [ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated) for the superseded original.
