# Includes

```http
GET /books?include=author,reviews.user
```

`include` takes a comma-separated list of dot-paths, merged into one tree. Only relations the entity marks `includable` can appear here (see [Relations](/features/relations)). An un-includable or misspelled relation is a 400.
