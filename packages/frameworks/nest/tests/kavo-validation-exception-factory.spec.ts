import { describe, expect, it } from "vitest";
import type { ValidationError } from "class-validator";
import {
  kavoValidationExceptionFactory,
  type KavoValidationExceptionBody,
} from "../src/kavo-validation-exception-factory.js";

function bodyOf(errors: ValidationError[]): KavoValidationExceptionBody {
  return kavoValidationExceptionFactory(errors).getResponse() as KavoValidationExceptionBody;
}

describe("kavoValidationExceptionFactory", () => {
  it("dedupes an identical message shared by two failing constraints on one property (issue #437)", () => {
    const body = bodyOf([
      {
        property: "amount",
        constraints: {
          isNumber: "amount must be a valid billing amount",
          isPositive: "amount must be a valid billing amount",
        },
      } as ValidationError,
    ]);
    expect(body.fieldErrors).toEqual([{ field: "amount", detail: "amount must be a valid billing amount" }]);
    // The flattened `message` doesn't repeat it either — the whole point.
    expect(body.message.match(/amount must be a valid billing amount/g)).toHaveLength(1);
  });

  it("keeps two distinct failing constraints on one property as a single entry", () => {
    const body = bodyOf([
      {
        property: "email",
        constraints: {
          isEmail: "email must be a valid email address",
          isNotEmpty: "email should not be empty",
        },
      } as ValidationError,
    ]);
    expect(body.fieldErrors).toHaveLength(1);
    expect(body.fieldErrors[0]?.field).toBe("email");
    expect(body.fieldErrors[0]?.detail).toContain("email must be a valid email address");
    expect(body.fieldErrors[0]?.detail).toContain("email should not be empty");
  });

  it("produces one entry per field across multiple properties", () => {
    const body = bodyOf([
      { property: "project", constraints: { isString: "project must be a string" } } as ValidationError,
      { property: "amount", constraints: { isPositive: "amount must be positive" } } as ValidationError,
    ]);
    expect(body.fieldErrors).toEqual([
      { field: "project", detail: "project must be a string" },
      { field: "amount", detail: "amount must be positive" },
    ]);
  });

  it("dot-joins a nested ValidateNested child's property onto its parent, with no phantom parent entry", () => {
    const body = bodyOf([
      {
        property: "address",
        children: [
          {
            property: "street",
            constraints: { isString: "street must be a string" },
          } as ValidationError,
        ],
      } as ValidationError,
    ]);
    expect(body.fieldErrors).toEqual([{ field: "address.street", detail: "street must be a string" }]);
    // `fieldErrors[].detail` carries only the leaf's own message (the field
    // association lives in `field`), but the flattened `message` still
    // names the ancestor the way Nest's own default exceptionFactory would
    // have — no regression for a caller that only reads `detail` today.
    expect(body.message).toContain("address.street must be a string");
  });

  it("has no code on a field error, unlike a query issue", () => {
    const body = bodyOf([{ property: "x", constraints: { isString: "x must be a string" } } as ValidationError]);
    expect(body.fieldErrors[0]).not.toHaveProperty("code");
  });
});
