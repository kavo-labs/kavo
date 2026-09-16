import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDMMF } from "@prisma/internals";
import type { PrismaDatamodel } from "@kavo/prisma";

const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));

// Prisma 7's generated `Prisma.dmmf` is a runtime-minimized model and omits
// metadata Kavo needs, so tests compile the fixture schema through Prisma's
// full DMMF compiler instead.
const dmmf = await getDMMF({ datamodel: readFileSync(schemaPath, "utf8") });

export const testDatamodel = dmmf.datamodel as PrismaDatamodel;
