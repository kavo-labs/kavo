# Benchmarks

Kavo ships two benchmark suites in `tools/benchmark/`. They measure different things and answer different questions — which one to run depends on what you're trying to learn.

## Engine micro-benchmarks

Measures raw `engine.execute()` throughput — no HTTP layer, no NestJS, no ORM. Uses an in-memory fake adapter with 1 000 pre-seeded `Todo` records. This isolates Kavo's own overhead: config resolution, DTO derivation, query normalization, serialization.

```bash
pnpm benchmark:engine
```

Uses [vitest bench](https://vitest.dev/guide/features.html#benchmarking) with the `tinybench` reporter. Each operation runs sequentially for a default duration, reporting ops/sec, mean latency, and p75/p99 percentiles.

### What's measured

| Operation | Description |
|-----------|-------------|
| `readOne` | Fetch a single record by ID |
| `readMany` | List with pagination (20 and 100 records) |
| `createOne` | Insert with JSON body |
| `updateOne` | Full update |
| `patchOne` | Partial update |
| `deleteOne` | Delete |

## HTTP throughput

Measures full NestJS request lifecycle — HTTP parsing, routing, engine, adapter, serialization, response. Uses [autocannon](https://github.com/mcollina/autocannon) for realistic concurrent load: 50 connections, 10-second duration, pipelining 10.

```bash
pnpm benchmark:http
```

This runs as a regular `vitest run` (not `vitest bench`) because it needs to boot a NestJS application. The server starts once in `beforeAll`, all operations run against it, and the server shuts down in `afterAll`.

### What's measured

| Route | Operation |
|-------|-----------|
| `GET /todos?limit=20&sort=-priority` | List with pagination + sort |
| `GET /todos/:id` | Single fetch by ID |
| `POST /todos` | Create with JSON body |
| `PATCH /todos/:id` | Partial update |
| `DELETE /todos/:id` | Delete |

Both suites use a fake in-memory adapter (`InMemoryTodoAdapter`). There is no database involved — the bottleneck is the framework, not I/O. For real-world throughput numbers with a database, add a SQLite or PostgreSQL variant.

## Results

Measured on Apple M2 Pro, Node v26.5.1.

### Engine (ops/sec)

| Operation | ops/sec | p75 latency |
|-----------|--------:|------------:|
| readOne | ~40,000 | ~25 µs |
| readMany (20) | ~37,000 | ~27 µs |
| readMany (100) | ~36,000 | ~28 µs |
| createOne | ~25,000 | ~40 µs |
| updateOne | ~5,000 | ~200 µs |
| patchOne | ~5,000 | ~200 µs |
| deleteOne | ~1,700 | ~600 µs |

### HTTP (req/sec)

| Route | req/sec | p50 | p99 |
|-------|--------:|----:|----:|
| GET /todos | ~25,800 | 18 ms | 46 ms |
| GET /todos/:id | ~21,500 | 23 ms | 56 ms |
| POST /todos | ~18,400 | 26 ms | 61 ms |
| PATCH /todos/:id | ~17,200 | 27 ms | 59 ms |
| DELETE /todos/:id | ~39,900 | 12 ms | 23 ms |

The gap between engine and HTTP numbers is the NestJS + HTTP overhead per request. DELETE is fastest because it returns no body. Reads and writes that involve serialization/deserialization are slower.

## Not part of `pnpm check`

Benchmarks are opt-in. They are not a CI gate — run them manually when profiling a change, comparing adapter implementations, or investigating a performance regression.
