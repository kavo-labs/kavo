# ADR-0038 — Declaring `operations` at all makes it an exclusive whitelist

**Status:** accepted (issue #257)

## Context

Before this change, `EntityConfig.operations` merged per key: naming one
standard operation (`operations: { updateOne: { cache: { ttl: 60 } } } }`)
configured only that operation, and every other standard id resolved from
its own built-in/global/soft-delete default, untouched. That reads
naturally for the case the shape was built for — override one operation's
settings, leave the rest alone — but it does not match how a caller who
names a _subset_ of operations actually reads their own config: writing
down `createOne`, `updateOne`, and `deleteOne` and nothing else looks like
"this is the CRUD surface I want," not "this is the CRUD surface I want,
plus five operations I didn't mention." The gap between what the config
says and what a reader expects it to mean was the original report behind
this issue.

The two readings can't coexist under one resolution rule: a config that
names one operation to tweak a setting and a config that names one
operation to declare the whole surface are written identically. Something
has to decide which one `operations` means, and it can't be per-entry,
because the ambiguity is about the _set_ of operations, not about any one
entry's own shape.

## Decision

`operations` is resolved in two distinct modes, selected by whether the
key is present at all:

- **Absent** (`config.operations === undefined`): every standard id
  resolves from the existing chain — built-in default, then the global
  `KavoSettings.operations` boolean map (ADR-0015), then the
  soft-delete-declared auto-enable for `restoreOne` (ADR-0013). Nothing
  about this mode changed.
- **Present**, even as `{}`: every standard id not named in it is
  disabled, regardless of what the global default, the soft-delete
  auto-enable, or the built-in table would otherwise say. A named id
  resolves its own `enabled`: the `true`/`false` shorthand says so
  explicitly, in either direction; an object enables by being named —
  there is no `enabled` field to check instead, since the object's own
  presence already answers the question. A key present with an
  `undefined` value counts as absent, not as naming the id (the same way
  an optional property being `undefined` is conventionally "not set"
  rather than "set to nothing").

Custom operation ids are unaffected: they are registered whenever named,
independent of the standard-id whitelist rule above, exactly as before
(ADR-0006).

## Consequences

- This is a breaking change to a public config surface. A config that
  named a subset of standard operations to configure them, relying on the
  rest staying at their default, now silences the rest. Every caller with
  such a config has to enumerate the full operation set it wants once it
  names any of them.
- `restoreOne` and `purgeOne` no longer get their special-cased defaults
  (soft-delete auto-enable, permanently-off-until-named) once `operations`
  is declared at all — naming them is what enables them, the same as any
  other id. ADR-0013's rule still governs the _absent_ case.
- The global `KavoSettings.operations` default map (ADR-0015) is bypassed
  entirely for any id an entity's declared `operations` doesn't name — not
  merely overridden for the ids it does name, which is what ADR-0015
  originally described. See that ADR's issue #257 update.
- There is no `enabled` field on `OperationConfig` for a standard id, and
  no long form of the boolean shorthand — `{ enabled: true }` is a type
  error. The shorthand and object-presence are the only two ways to name
  an id, deliberately kept to two rather than three equivalent spellings.
