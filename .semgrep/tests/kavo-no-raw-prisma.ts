// Fixture for kavo-no-raw-prisma (.semgrep/kavo.yml).
declare const client: any;
declare const sql: string;
declare const id: number;

// ruleid: kavo-no-raw-prisma
client.$queryRawUnsafe(sql);
// ruleid: kavo-no-raw-prisma
client.$executeRawUnsafe(`DELETE FROM users WHERE id = ${id}`);

// The tagged-template forms, which Prisma parameterizes.
// ok: kavo-no-raw-prisma
client.$queryRaw`SELECT * FROM users WHERE id = ${id}`;
// ok: kavo-no-raw-prisma
client.$executeRaw`DELETE FROM users WHERE id = ${id}`;
// The delegate API.
// ok: kavo-no-raw-prisma
client.user.findMany({ where: { id } });
