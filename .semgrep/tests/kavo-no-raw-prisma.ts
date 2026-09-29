// Fixture for kavo-no-raw-prisma (.semgrep/kavo.yml).
declare const client: any;
declare const sql: string;
declare const id: number;

// ruleid: kavo-no-raw-prisma
client.$queryRawUnsafe(sql);
// ruleid: kavo-no-raw-prisma
client.$executeRawUnsafe(`DELETE FROM users WHERE id = ${id}`);

// The delegate API, which Prisma parameterizes.
// ok: kavo-no-raw-prisma
client.user.findMany({ where: { id } });
