import { describe, expect, it } from "vitest";
import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { toKavoExceptionShape } from "../src/unhandled-exception.js";

describe("toKavoExceptionShape", () => {
  it("maps a built-in HttpException to KAVO_HTTP_ERROR at its own status", () => {
    // Nest's own subclasses build an *object* body (`{ statusCode, message,
    // error }`) even when constructed from a string, so this exercises the
    // object arm. The genuine string-body case is the next test.
    const shape = toKavoExceptionShape(new NotFoundException("no boom here"));
    expect(shape.code).toBe("KAVO_HTTP_ERROR");
    expect(shape.status).toBe(404);
    expect(shape.detail).toContain("no boom here");
  });

  it("surfaces a bare string response body as the detail", () => {
    // `new HttpException("...", status)` keeps the response as a raw
    // string, which an app writing its own exceptions does routinely.
    const shape = toKavoExceptionShape(new HttpException("plain text body", 418));
    expect(shape.code).toBe("KAVO_HTTP_ERROR");
    expect(shape.status).toBe(418);
    expect(shape.detail).toContain("plain text body");
  });

  it("joins an array `message` (ValidationPipe shape) into one detail string", () => {
    const shape = toKavoExceptionShape(new BadRequestException(["title must be a string", "title is required"]));
    expect(shape.status).toBe(400);
    expect(shape.detail).toContain("title must be a string");
    expect(shape.detail).toContain("title is required");
  });

  it("maps a plain thrown Error to KAVO_UNEXPECTED_ERROR at 500, keeping it as the cause", () => {
    const original = new Error("db pool exhausted");
    const shape = toKavoExceptionShape(original);
    expect(shape.code).toBe("KAVO_UNEXPECTED_ERROR");
    expect(shape.status).toBe(500);
    expect(shape.cause).toBe(original);
    expect(shape.detail).not.toContain("db pool exhausted");
  });

  it.each([
    ["a string", "just a string throw"],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { reason: "not an Error at all" }],
  ])("maps %s thrown value to KAVO_UNEXPECTED_ERROR without throwing itself", (_label, thrown) => {
    const shape = toKavoExceptionShape(thrown);
    expect(shape.code).toBe("KAVO_UNEXPECTED_ERROR");
    expect(shape.status).toBe(500);
    expect(shape.cause).toBe(thrown);
  });

  it("falls back to the HttpException's own .message when getResponse() has no message field", () => {
    const shape = toKavoExceptionShape(new HttpException({ statusCode: 400 }, 400));
    expect(shape.status).toBe(400);
    expect(shape.detail.length).toBeGreaterThan(0);
  });

  it("never sets a correlation instance for either synthetic shape", () => {
    expect(toKavoExceptionShape(new NotFoundException("x")).context.correlationId).toBeUndefined();
    expect(toKavoExceptionShape(new Error("x")).context.correlationId).toBeUndefined();
  });

  describe("issue field errors (kavoValidationExceptionFactory body)", () => {
    it("surfaces a fieldErrors array as KavoExceptionShape.issues", () => {
      const shape = toKavoExceptionShape(
        new BadRequestException({
          message: "amount must be a positive number",
          fieldErrors: [{ field: "amount", detail: "amount must be a positive number" }],
        }),
      );
      expect(shape.code).toBe("KAVO_HTTP_ERROR");
      expect(shape.issues).toEqual([{ field: "amount", detail: "amount must be a positive number" }]);
    });

    it("omits issues when there is no fieldErrors key at all", () => {
      const shape = toKavoExceptionShape(new BadRequestException(["a plain flattened message"]));
      expect(shape.issues).toBeUndefined();
    });

    it("omits issues when fieldErrors is present but not an array", () => {
      const shape = toKavoExceptionShape(new BadRequestException({ message: "x", fieldErrors: "not-an-array" }));
      expect(shape.issues).toBeUndefined();
    });

    it("omits issues for an empty fieldErrors array rather than surfacing errors: []", () => {
      const shape = toKavoExceptionShape(new BadRequestException({ message: "x", fieldErrors: [] }));
      expect(shape.issues).toBeUndefined();
    });

    it("omits issues entirely when any entry fails the structural guard", () => {
      const shape = toKavoExceptionShape(
        new BadRequestException({
          message: "x",
          fieldErrors: [{ field: "amount", detail: "ok" }, { field: "amount" /* no detail */ }],
        }),
      );
      expect(shape.issues).toBeUndefined();
    });
  });
});
