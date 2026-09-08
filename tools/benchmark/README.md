# Kavo Benchmarks

Engine micro-benchmarks and HTTP throughput measurements.

## Engine benchmarks (vitest bench)

Measures `engine.execute()` throughput — no HTTP, no ORM. Uses `InMemoryTodoAdapter` with 1 000 pre-seeded records.

```bash
pnpm benchmark:engine
```

## HTTP benchmarks (vitest bench + autocannon)

Measures full NestJS request lifecycle — HTTP parsing, routing, engine, adapter, response. Uses autocannon for realistic load generation.

```bash
pnpm benchmark:http              # both modes
pnpm benchmark:http:fake         # fake in-memory adapter only
pnpm benchmark:http:sqlite       # in-memory SQLite only
```

### Modes

| Mode       | Adapter                    | What it adds vs engine-only                 |
| ---------- | -------------------------- | ------------------------------------------- |
| **fake**   | `InMemoryTodoAdapter`      | HTTP parsing, NestJS routing, serialization |
| **sqlite** | TypeORM + in-memory SQLite | Above + real ORM, SQL generation            |

## What's measured

| Route                                | Operation                   |
| ------------------------------------ | --------------------------- |
| `GET /todos?limit=20&sort=-priority` | List with pagination + sort |
| `GET /todos/:id`                     | Single fetch by ID          |
| `POST /todos`                        | Create with JSON body       |
| `PATCH /todos/:id`                   | Partial update              |
| `DELETE /todos/:id`                  | Delete                      |

autocannon params: 10 connections, 1s duration per bench iteration, pipelining 10.

## Not part of `pnpm check`

Benchmarks are opt-in. Run them manually to measure performance, not as a CI gate.
