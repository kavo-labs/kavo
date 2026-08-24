import { describe, expect, it } from "vitest";
import { IsString, validate } from "class-validator";
import { entityHasValidationMetadata, entityPartialValidationClass } from "../src/load-class-validator.js";

class Decorated {
  @IsString()
  title = "";
}

class Undecorated {
  title = "";
}

class DecoratedSubclass extends Decorated {
  extra = "";
}

describe("entityHasValidationMetadata (issue #283)", () => {
  it("is true for a class carrying its own class-validator decorator", () => {
    expect(entityHasValidationMetadata(Decorated)).toBe(true);
  });

  it("is false for a plain class with no class-validator decorators", () => {
    expect(entityHasValidationMetadata(Undecorated)).toBe(false);
  });

  it("is true for a subclass inheriting a decorated property", () => {
    expect(entityHasValidationMetadata(DecoratedSubclass)).toBe(true);
  });
});

describe("entityPartialValidationClass (issue #285)", () => {
  it("returns null for a class with no class-validator decorators", () => {
    expect(entityPartialValidationClass(Undecorated)).toBeNull();
  });

  it("accepts a body omitting a required field of the entity", async () => {
    const PartialDecorated = entityPartialValidationClass(Decorated);
    expect(PartialDecorated).not.toBeNull();
    const instance = Object.assign(new (PartialDecorated as unknown as new () => Decorated)(), {});
    delete (instance as { title?: string }).title;

    const errors = await validate(instance);

    expect(errors).toEqual([]);
  });

  it("still rejects a present field that fails the entity's own validator", async () => {
    const PartialDecorated = entityPartialValidationClass(Decorated);
    const instance = Object.assign(new (PartialDecorated as unknown as new () => Decorated)(), { title: 42 });

    const errors = await validate(instance);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("title");
  });

  it("caches the same subclass for repeated calls on the same entity", () => {
    expect(entityPartialValidationClass(Decorated)).toBe(entityPartialValidationClass(Decorated));
  });
});
