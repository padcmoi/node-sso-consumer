import type { RowDataPacket } from "mysql2/promise";

interface ServiceRow extends RowDataPacket {
  id: number;
  name: string;
  kind: string;
  status: string;
  host: string;
  updated_at: Date;
}

/**
 * This application's OWN data, behind the guard.
 *
 * The gate declared to x-core says who may come in at all; whether this reader may
 * touch this row is this application's business, and always was. Here it asks for
 * nothing beyond a session, which is the ordinary case.
 */
export default defineEventHandler(async (event) => {
  await requireSession(event);

  const rows = await dbSelect<ServiceRow>("SELECT id, name, kind, status, host, updated_at FROM services ORDER BY id");

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    host: row.host,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
});
