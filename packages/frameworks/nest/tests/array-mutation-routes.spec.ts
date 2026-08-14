import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { RequestMethod } from "@nestjs/common";
import { Kavo } from "@kavo/nest";

// `@nestjs/common/constants`'s subpath isn't part of its declared type
// exports (no `exports` map restricts it at runtime, but `tsc`'s Node16
// resolution can't see the `.d.ts` through it) — the same reason
// `kavo.decorator.ts` inlines its own `NEST_ROUTE_ARGS_METADATA` rather than
// importing it. These two are stable across Nest's own major versions.
const PATH_METADATA = "path";
const METHOD_METADATA = "method";

class Tag {
  id = 0;
  name = "";
}

class Post {
  id = 0;
  title = "";
  tags: Tag[] = [];
}

describe("@Kavo — replace<Relation> sub-collection route generation (arrayMutation's replace strategy, ADR-0014)", () => {
  it("generates PUT :id/<relation> for a relation opted into relations.edges.<name>.write", () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
    class PostController {}

    const method = (PostController.prototype as Record<string, unknown>).replaceTags as (...args: unknown[]) => unknown;
    expect(typeof method).toBe("function");
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(":id/tags");
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.PUT);
  });

  it("generates no route when the relation never opts in", () => {
    @Kavo(Post)
    class PlainController {}

    expect((PlainController.prototype as Record<string, unknown>).replaceTags).toBeUndefined();
  });

  it("generates no replace<Relation> route when the entity declares arrayMutation.strategy: 'jsonPatch'", () => {
    @Kavo(Post, { arrayMutation: { strategy: "jsonPatch" }, relations: { edges: { tags: { write: true } } } } as never)
    class JsonPatchController {}

    // No synthesized PUT :id/tags route — jsonPatch reuses patchOne's own
    // PATCH :id route instead (ADR-0029's jsonPatch amendment).
    expect((JsonPatchController.prototype as Record<string, unknown>).replaceTags).toBeUndefined();
  });

  it("a hand-written method named replace<Relation> wins over the generated route (manual-method-wins)", () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
    class OverriddenController {
      replaceTags(): string {
        return "manual";
      }
    }

    // manual-method-wins skips `defineRoute` entirely for a name already
    // own to the prototype — the method itself must never have been
    // decorated, not merely still return its own value alongside a
    // generated route wired underneath it.
    const method = OverriddenController.prototype.replaceTags;
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBeUndefined();
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBeUndefined();
    expect(new OverriddenController().replaceTags()).toBe("manual");
  });
});
