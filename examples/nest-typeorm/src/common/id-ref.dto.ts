import { IsInt, IsPositive } from "class-validator";

/**
 * The wire shape association-by-id (ADR-0014) requires for a single-key
 * relation: a reference object naming the target's id, `{ "id": 7 }`. A
 * bare scalar (`7`) is rejected by the deserializer rather than accepted as
 * shorthand (`AssociationInvalidShapeException`, issue #291), so every
 * relation-typed field across this app's write DTOs validates against this
 * shape instead of a plain number.
 */
export class IdRefDto {
  @IsInt()
  @IsPositive()
  id = 0;
}
