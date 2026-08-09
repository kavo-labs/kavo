import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

/**
 * Just enough of `IncomingMessage`/`ServerResponse` for `handleRequest` unit
 * tests to drive `createTransport` without a real socket — the
 * integration suite (`integration.spec.ts`) is what exercises a genuine
 * `http.Server` end to end. `writableLength` is settable directly so the
 * bounded-buffer test can simulate a slow reader without actually stalling
 * one.
 */
export function fakeRequest(url: string, headers: IncomingHttpHeaders = {}): { req: IncomingMessage; close(): void } {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, { method: "GET", url, headers }) as unknown as IncomingMessage;
  return {
    req,
    close: () => emitter.emit("close"),
  };
}

/**
 * A class (not an object literal merged onto an `EventEmitter`) because
 * `statusCode`/`ended`/`jsonBody` must stay *live* accessors — `Object.
 * assign` would have read a getter once at construction time and copied
 * its snapshot value instead, which is exactly wrong for state a test
 * mutates by calling `writeHead`/`end` and then asserts on afterward.
 */
class FakeServerResponse extends EventEmitter {
  writableLength = 0;
  readonly frames: string[] = [];
  private _statusCode = 0;
  private _headers: Record<string, string | number> = {};
  private _jsonBody: unknown;
  private _ended = false;

  get statusCode(): number {
    return this._statusCode;
  }

  get headers(): Record<string, string | number> {
    return this._headers;
  }

  get jsonBody(): unknown {
    return this._jsonBody;
  }

  get ended(): boolean {
    return this._ended;
  }

  writeHead(code: number, headers?: Record<string, string | number>): this {
    this._statusCode = code;
    if (headers !== undefined) this._headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) {
      try {
        this._jsonBody = JSON.parse(chunk) as unknown;
      } catch {
        this.frames.push(chunk);
      }
    }
    this._ended = true;
    return this;
  }

  flushHeaders(): void {
    // no-op: nothing to flush over a fake socket.
  }
}

export interface FakeResponse extends ServerResponse {
  readonly frames: string[];
  readonly headers: Record<string, string | number>;
  readonly jsonBody: unknown;
  readonly ended: boolean;
}

export function fakeResponse(): FakeResponse {
  return new FakeServerResponse() as unknown as FakeResponse;
}

/**
 * `ServerResponse.writableLength` is declared read-only in `@types/node`
 * (it is, on a real socket) — this is the one place a test needs to fake a
 * slow reader by setting it directly, so the cast lives here once instead
 * of in every test that simulates backpressure.
 */
export function setWritableLength(res: FakeResponse, bytes: number): void {
  (res as unknown as { writableLength: number }).writableLength = bytes;
}
