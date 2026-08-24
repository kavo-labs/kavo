import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  Controller,
  Injectable,
  type ArgumentMetadata,
  type INestApplication,
  type PipeTransform,
} from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { IsString } from "class-validator";
import type { EntityMetadata, KavoInfrastructure } from "@kavo/core";
import { Kavo, KavoModule, Override, boundKavoService } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * Issue #281: a generated (non-`@Override()`'d) route's `@Body()` parameter
 * carries no source-level type declaration, so TypeScript's
 * `emitDecoratorMetadata` never writes `design:paramtypes` for it — and
 * Nest's own pipe system resolves a `PipeTransform`'s `ArgumentMetadata.metatype`
 * off exactly that reflection metadata. Before the fix, a registered
 * `dto.create`/`dto.update`/`dto.patch` class was invisible to any global
 * pipe on a generated route: `metatype` always came back `Object`, whatever
 * class was configured. `RecordingPipe` below stands in for any real
 * validator hooked through Nest's pipe system (`class-validator`'s
 * `ValidationPipe`, `nestjs-zod`, or a hand-written one) — the fix is
 * pinned at the mechanism Nest itself uses, not at one validation library.
 */
class RecordingPipe implements PipeTransform {
  static metatypes: unknown[] = [];

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === "body") RecordingPipe.metatypes.push(metadata.metatype);
    return value;
  }
}

@Injectable()
class GlobalRecordingPipe extends RecordingPipe {}

class CreateTodoDto {
  title = "";
}

class UpdateTodoDto {
  title = "";
}

let app: INestApplication;
let httpServer: SupertestTarget | undefined;

async function bootstrap(controllers: readonly unknown[]): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature(controllers as never),
    ],
    providers: [{ provide: APP_PIPE, useClass: GlobalRecordingPipe }],
  }).compile();
  app = moduleRef.createNestApplication();
  httpServer = await listen(app);
}

beforeEach(() => {
  RecordingPipe.metatypes.length = 0;
});

afterEach(async () => {
  httpServer = undefined;
  await app.close();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

describe("generated route body metatype (issue #281)", () => {
  it("exposes the registered dto.create class to a global pipe, not Object", async () => {
    @Kavo(Todo, { dto: { create: CreateTodoDto } })
    @Controller("todos")
    class TodosController {}

    await bootstrap([TodosController]);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    expect(RecordingPipe.metatypes).toEqual([CreateTodoDto]);
  });

  it("exposes the registered dto.update class on a generated PUT route", async () => {
    @Kavo(Todo, { dto: { create: CreateTodoDto, update: UpdateTodoDto } })
    @Controller("todos")
    class TodosController {}

    await bootstrap([TodosController]);
    const created = await request(server()).post("/todos").send({ title: "x" }).expect(201);
    RecordingPipe.metatypes.length = 0;
    await request(server()).put(`/todos/${created.body.id}`).send({ title: "y" }).expect(200);

    expect(RecordingPipe.metatypes).toEqual([UpdateTodoDto]);
  });

  it("leaves the metatype unresolved when no dto.create is registered and the entity carries no validation decorators", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class TodosController {}

    await bootstrap([TodosController]);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    expect(RecordingPipe.metatypes).toEqual([undefined]);
  });

  it("does not disturb an @Override()'d route's own real design:paramtypes", async () => {
    @Kavo(Todo, { dto: { create: CreateTodoDto } })
    @Controller("todos")
    class TodosController {
      @Override()
      async createOne(dto: CreateTodoDto) {
        return boundKavoService<Todo>(this).createOne(dto as never);
      }
    }

    await bootstrap([TodosController]);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    expect(RecordingPipe.metatypes).toEqual([CreateTodoDto]);
  });
});

/**
 * Issue #283: an unregistered `dto.create`/`dto.update`/`dto.patch` slot
 * falls back to the entity class itself, but only when it actually carries
 * `class-validator` decorators — gated in `entityFallbackDto`
 * (`kavo.decorator.ts`) via `entityHasValidationMetadata`
 * (`load-class-validator.ts`). The gate matters: under
 * `ValidationPipe({ whitelist: true })` (this repo's own example config),
 * naming an *undecorated* class as the body metatype would strip every
 * property instead of validating them — the case the previous describe
 * block's "leaves the metatype unresolved" test guards.
 */
class ValidatedTodo {
  id = 0;
  @IsString()
  title = "";
}

function validatedTodoInfrastructure(adapter: InMemoryTodoAdapter): KavoInfrastructure {
  const metadata: EntityMetadata<ValidatedTodo> = {
    entity: ValidatedTodo,
    name: "ValidatedTodo",
    idField: "id",
    fields: [
      { name: "id", kind: "number", nullable: false, generated: true },
      { name: "title", kind: "string", nullable: false, generated: false },
    ],
    relations: [],
  };
  return {
    metadataFor: <Entity extends object>() => metadata as unknown as EntityMetadata<Entity>,
    adapterFor: <Entity extends object>() => ({
      findOneById: () => Promise.reject(new Error("unused")),
      findOne: () => Promise.reject(new Error("unused")),
      findMany: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
      create: (data: Partial<Entity>) =>
        Promise.resolve({ ...new ValidatedTodo(), ...data, id: adapter.rows.length + 1 } as unknown as Entity),
      update: () => Promise.reject(new Error("unused")),
      patch: () => Promise.reject(new Error("unused")),
      delete: () => Promise.reject(new Error("unused")),
      restore: () => Promise.reject(new Error("unused")),
      purge: () => Promise.reject(new Error("unused")),
    }),
  };
}

describe("entity-class DTO fallback (issue #283)", () => {
  it("exposes the entity class as the body metatype when it carries validation decorators", async () => {
    @Kavo(ValidatedTodo)
    @Controller("validated-todos")
    class ValidatedTodosController {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: validatedTodoInfrastructure(new InMemoryTodoAdapter()) }),
        KavoModule.forFeature([ValidatedTodosController] as never),
      ],
      providers: [{ provide: APP_PIPE, useClass: GlobalRecordingPipe }],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);

    await request(server()).post("/validated-todos").send({ title: "x" }).expect(201);

    expect(RecordingPipe.metatypes).toEqual([ValidatedTodo]);
  });

  it("rejects a body that fails the entity's own validation decorators, through a real ValidationPipe", async () => {
    @Kavo(ValidatedTodo)
    @Controller("validated-todos")
    class ValidatedTodosController {}

    const { ValidationPipe } = await import("@nestjs/common");
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: validatedTodoInfrastructure(new InMemoryTodoAdapter()) }),
        KavoModule.forFeature([ValidatedTodosController] as never),
      ],
      providers: [{ provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) }],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);

    // `title` must be a string — a number fails `@IsString()`.
    await request(server()).post("/validated-todos").send({ title: 42 }).expect(400);
  });
});
