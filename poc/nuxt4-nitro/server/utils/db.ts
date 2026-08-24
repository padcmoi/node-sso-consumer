import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";

let pool: Pool | undefined;

export function useDb() {
  if (!pool) {
    const config = useRuntimeConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: Number(config.db.port),
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      waitForConnections: true,
      connectionLimit: 5,
      charset: "utf8mb4_general_ci",
    });
  }
  return pool;
}

export async function dbSelect<T extends RowDataPacket>(sql: string, params: unknown[] = []) {
  const [rows] = await useDb().query<T[]>(sql, params);
  return rows;
}

export async function dbExecute(sql: string, params: unknown[] = []) {
  await useDb().query(sql, params);
}
