// Fixture for kavo-no-dynamic-code (.semgrep/kavo.yml).
declare const source: string;

// ruleid: kavo-no-dynamic-code
eval(source);
// ruleid: kavo-no-dynamic-code
const compiled = new Function("row", source);

// Parsing data is not evaluating code.
// ok: kavo-no-dynamic-code
const parsed: unknown = JSON.parse(source);
