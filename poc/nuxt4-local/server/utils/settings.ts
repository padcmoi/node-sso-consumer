import type { RowDataPacket } from 'mysql2/promise'

/**
 * The key/value shelf the library keeps its state in, as two functions.
 *
 * The library knows nothing else about it: it hands an object over and takes one
 * back. Where the rows live is this application's business.
 *
 * `type` is a COLUMN and not a convention. The library hands over JavaScript values
 * and takes JavaScript values back, and stored as one opaque blob that shape
 * survives only as long as whoever reads it remembers to parse - the first reader
 * who does not is a boot comparing the string 'false' to `false`. In this mode only
 * two strings are ever written, but the shelf is the same shelf, and a POC that
 * simplified it here would be read as a licence to simplify it there.
 */
interface SettingRow extends RowDataPacket {
  key: string
  type: string
  value: string
}

export type AppSettingType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'

/** A row that cannot be read, told apart from a row holding `null`. */
const UNREADABLE = Symbol('unreadable')

const readSetting = (type: string, value: string) => {
  if (type === 'null') return null
  if (type === 'string') return value

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return UNREADABLE
  }

  // The declared type is CHECKED against what came back rather than trusted.
  if (type === 'array') return Array.isArray(parsed) ? parsed : UNREADABLE
  if (type === 'object') return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : UNREADABLE
  if (type === 'number') return typeof parsed === 'number' ? parsed : UNREADABLE
  if (type === 'boolean') return typeof parsed === 'boolean' ? parsed : UNREADABLE
  return UNREADABLE
}

const typeOf = (value: unknown): AppSettingType => {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  return 'string'
}

/** A string is stored RAW rather than JSON-encoded, so the table stays readable. */
const writeSetting = (value: unknown) => {
  const type = typeOf(value)
  if (type === 'null') return { type, text: 'null' }
  if (type === 'string') return { type, text: String(value) }
  return { type, text: JSON.stringify(value) }
}

export const settings = {
  /**
   * Everything, in one read, and it runs before anything else at boot.
   *
   * A key that was never written is ABSENT rather than `null`, which is what tells
   * "never set" apart from "set to nothing".
   */
  async all() {
    const rows = await dbSelect<SettingRow>('SELECT `key`, `type`, `value` FROM app_settings')

    const held: Record<string, unknown> = {}
    for (const row of rows) {
      const value = readSetting(row.type, row.value)
      // Skipped rather than fatal: a store that refuses to be read at all would stop
      // a boot over one bad line.
      if (value === UNREADABLE) console.warn(`[settings] ${row.key} is not a readable ${row.type} and was ignored`)
      else held[row.key] = value
    }
    return held
  },

  /** CREATE OR UPDATE each key given, in one transaction, and leave the others alone. */
  async upsertAll(values: Record<string, unknown>) {
    const entries = Object.entries(values)
    if (!entries.length) return

    const connection = await useDb().getConnection()
    try {
      await connection.beginTransaction()
      for (const [key, value] of entries) {
        const { type, text } = writeSetting(value)
        await connection.query(
          'INSERT INTO app_settings (`key`, `type`, `value`) VALUES (?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE `type` = VALUES(`type`), `value` = VALUES(`value`)',
          [key, type, text],
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  },
}
