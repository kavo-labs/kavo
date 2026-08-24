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

  it("leaves the metatype unresolved when no dto.create is registered", async () => {
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
