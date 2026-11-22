import { readFile, readdir } from "node:fs/promises";

export async function migrateLocal(database) {
  const migrations = (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of migrations) {
    const sql = await readFile("drizzle/" + filename, "utf8");
    const statements = sql.split("--> statement-breakpoint").map((statement) => database.prepare(statement.trim()));
    await database.batch(statements);
  }
}
