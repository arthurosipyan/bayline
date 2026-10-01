import { buildApp } from "./app.js";
import { migrate } from "./migrate.js";
import { openDatabase } from "./postgres.js";

const database = await openDatabase();
await migrate(database.pool);
const app = buildApp(database.pool);
const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "127.0.0.1" });
console.log(`bayline listening on ${port}`);
