import { expect } from "vitest";

/**
 * fast-check run parameters shared by the `fuzz-*.spec.ts` suites. `FC_SEED`
 * pins the run (CI sets it) so a failure replays; unset, every local run
 * explores fresh inputs. A seed that isn't an integer throws rather than
 * falling back to a random run, so a mistyped replay can't pass as "not
 * reproducible".
 */
export function fuzzRuns(numRuns = 2000): { numRuns: number; seed?: number } {
  const raw = process.env["FC_SEED"];
  if (raw === undefined || raw === "") {
    return { numRuns };
  }
  const seed = Number(raw);
  if (!Number.isInteger(seed)) {
    throw new Error(`FC_SEED must be an integer, got ${JSON.stringify(raw)}`);
  }
  return { numRuns, seed };
}

/**
 * Every `Object.prototype` and `Array.prototype` member, value and all, so a
 * check catches an overwritten member (`toString = …`) as well as an added key.
 */
function prototypeSnapshot(): ReadonlyArray<readonly [PropertyKey, unknown]> {
  return [Object.prototype, Array.prototype].flatMap((proto) =>
    Reflect.ownKeys(proto).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key)!;
      return [key, descriptor.value ?? descriptor.get] as const;
    }),
  );
}

const pristine = prototypeSnapshot();

/** Fails if anything was added to, or replaced on, the built-in prototypes since load. */
export function expectPrototypesIntact(): void {
  expect(prototypeSnapshot()).toEqual(pristine);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
}
