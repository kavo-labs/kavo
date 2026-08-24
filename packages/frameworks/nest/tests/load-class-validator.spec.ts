import { describe, expect, it } from "vitest";
import { IsString } from "class-validator";
import { entityHasValidationMetadata } from "../src/load-class-validator.js";

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
