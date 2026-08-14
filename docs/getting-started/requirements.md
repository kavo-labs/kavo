# Requirements

- **Node.js 20 or newer** — every `@kavo/*` package declares `engines.node: ">=20"`, so your package manager will warn (or, under `engine-strict`, refuse) an install on an older release.
- **ESM** — every `@kavo/*` package ships as ESM only, with no CommonJS entry point. Your app must be ESM too (`"type": "module"` in its `package.json`), which the default `nest new` scaffold is not.
- **Decorator metadata** — `experimentalDecorators` and `emitDecoratorMetadata` must be on. `@Kavo()` reads your entity's decorator metadata, and so do TypeORM's columns and Nest's DI.

A `tsconfig.json` that satisfies all three:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "strict": true,
    "skipLibCheck": true
  }
}
```

`useDefineForClassFields: false` is load-bearing at `ES2022` and above. With it on, every declared field is emitted as a real class field set to `undefined` when not hydrated — so a partially-loaded entity looks fully populated, `undefined` values leak into responses instead of being absent, and TypeORM's persistence diffing treats them as explicit writes. With it off (what Kavo's own packages and both example apps use), only hydrated fields are set.
