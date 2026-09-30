// Fixture for kavo-no-dynamic-code (.semgrep/kavo.yml).
declare const source: string;
declare const engine: { evaluate(source: string): unknown };

// ruleid: kavo-no-dynamic-code
eval(source);
// ruleid: kavo-no-dynamic-code
globalThis.eval(source);
// ruleid: kavo-no-dynamic-code
const compiled = new Function("row", source);
// ruleid: kavo-no-dynamic-code
const called = Function("row", source);

// A method that merely shares the name is not flagged.
// ok: kavo-no-dynamic-code
engine.evaluate(source);
// ok: kavo-no-dynamic-code
const parsed: unknown = JSON.parse(source);
