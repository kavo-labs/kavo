/**
 * A minimal JSON Schema fragment — just enough shape for the component
 * schemas this module builds. Not a full JSON Schema type; callers that
 * need one should treat this as `Record<string, unknown>` with common
 * keywords named for editor completion.
 */
export interface JsonSchema {
  type?: string | readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  format?: string;
  nullable?: boolean;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  title?: string;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
  allOf?: readonly JsonSchema[];
  [key: string]: unknown;
}
