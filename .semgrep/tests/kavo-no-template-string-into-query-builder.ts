// Fixture for kavo-no-template-string-into-query-builder (.semgrep/kavo.yml).
declare const qb: any;
declare const manager: any;
declare const logger: any;
declare const column: string;
declare const parameter: string;
declare const relation: string;
declare const relatedIdField: string;
declare const parentAlias: string;
declare const node: { relation: { name: string } };
declare function keyScratch(name: string): string;
declare const value: unknown;
declare const id: unknown;
declare const request: { query: { sort: string; search: string } };

// A value interpolated into a template string.
// ruleid: kavo-no-template-string-into-query-builder
qb.where(`${column} = ${value}`);
// ruleid: kavo-no-template-string-into-query-builder
qb.andWhere(`${this.alias}.id = ${id}`, {});
// ruleid: kavo-no-template-string-into-query-builder
qb.orWhere(`id = ${id}`);
// ruleid: kavo-no-template-string-into-query-builder
qb.orderBy(`${request.query.sort}`);
// ruleid: kavo-no-template-string-into-query-builder
qb.leftJoinAndSelect(`${request.query.sort}`, "x");
// ruleid: kavo-no-template-string-into-query-builder
qb.leftJoinAndMapOne(`a.${request.query.sort}`, "b");
// ruleid: kavo-no-template-string-into-query-builder
manager.query(`SELECT * FROM users WHERE id = ${id}`);
// A fragment in a later argument, such as a join condition, counts too.
// ruleid: kavo-no-template-string-into-query-builder
qb.innerJoin(`${this.alias}.${relation}`, "member", `member.id = ${id}`);

// A value concatenated, on either side of `+`, or through concat/join.
// ruleid: kavo-no-template-string-into-query-builder
qb.where("name LIKE '%" + request.query.search, {});
// ruleid: kavo-no-template-string-into-query-builder
qb.addOrderBy(request.query.sort + " DESC");
// ruleid: kavo-no-template-string-into-query-builder
qb.where("id = ".concat(id));
// ruleid: kavo-no-template-string-into-query-builder
qb.where(["id =", id].join(" "));

// A fragment built into a variable first, then passed. Semgrep reports this
// shape at the assignment, where the match starts.
function buildFirst() {
  // ruleid: kavo-no-template-string-into-query-builder
  const fragment = `id = ${id}`;
  qb.where(fragment);
}

// Identifiers from the vetted vocabulary, with values bound as parameters.
// ok: kavo-no-template-string-into-query-builder
qb.where(`${column} = :${parameter}`, { [parameter]: value });
// ok: kavo-no-template-string-into-query-builder
qb.andWhere(`${this.alias}.${this.idField} = :id`, { id });
// ok: kavo-no-template-string-into-query-builder
qb.innerJoin(`${this.alias}.${relation}`, "member", `member.${relatedIdField} = :memberId`, { memberId: id });
// ok: kavo-no-template-string-into-query-builder
qb.loadRelationIdAndMap(`${parentAlias}.${keyScratch(node.relation.name)}`, `${parentAlias}.${node.relation.name}`);
function vettedVariable() {
  // ok: kavo-no-template-string-into-query-builder
  const fragment = `${column} = :${parameter}`;
  qb.where(fragment, { [parameter]: value });
}
// A string-built message passed to a method that is not a query builder.
// ok: kavo-no-template-string-into-query-builder
logger.warn(`${value} is not a valid id`);
