// Fixture for kavo-no-template-string-into-query-builder (.semgrep/kavo.yml).
declare const qb: any;
declare const manager: any;
declare const column: string;
declare const parameter: string;
declare const relation: string;
declare const relatedIdField: string;
declare const value: unknown;
declare const id: unknown;
declare const request: { query: { sort: string; search: string } };

// ruleid: kavo-no-template-string-into-query-builder
qb.where(`${column} = ${value}`);
// ruleid: kavo-no-template-string-into-query-builder
qb.andWhere(`${this.alias}.id = ${id}`, {});
// ruleid: kavo-no-template-string-into-query-builder
qb.orderBy(`${request.query.sort}`);
// ruleid: kavo-no-template-string-into-query-builder
qb.where("name LIKE '%" + request.query.search, {});
// ruleid: kavo-no-template-string-into-query-builder
manager.query(`SELECT * FROM users WHERE id = ${id}`);
// A fragment in a later argument, such as a join condition, counts too.
// ruleid: kavo-no-template-string-into-query-builder
qb.innerJoin(`${this.alias}.${relation}`, "member", `member.id = ${id}`);

// Identifiers from the vetted vocabulary, with values bound as parameters.
// ok: kavo-no-template-string-into-query-builder
qb.where(`${column} = :${parameter}`, { [parameter]: value });
// ok: kavo-no-template-string-into-query-builder
qb.andWhere(`${this.alias}.${this.idField} = :id`, { id });
// ok: kavo-no-template-string-into-query-builder
qb.innerJoin(`${this.alias}.${relation}`, "member", `member.${relatedIdField} = :memberId`, { memberId: id });
// A template string that is not passed to a query-builder method.
// ok: kavo-no-template-string-into-query-builder
const message = `${value} is not a valid id`;
