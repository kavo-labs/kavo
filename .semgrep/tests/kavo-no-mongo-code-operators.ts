// Fixture for kavo-no-mongo-code-operators (.semgrep/kavo.yml).
declare const model: any;
declare const body: string;

// ruleid: kavo-no-mongo-code-operators
model.find({ $where: body });
// ruleid: kavo-no-mongo-code-operators
model.aggregate([{ $addFields: { x: { $function: { body, args: [], lang: "js" } } } }]);
// ruleid: kavo-no-mongo-code-operators
model.aggregate([{ $group: { _id: null, x: { $accumulator: {} } } }]);

// Query operators that take data, not code.
// ok: kavo-no-mongo-code-operators
model.find({ name: { $regex: "^a", $options: "i" }, $expr: { $gt: ["$a", 1] } });
