import { AppSettingEntity, type AppSettingRow } from "./entities";

/**
 * The key/value shelf the library keeps its state in, as two functions.
 *
 * The library knows nothing else about it: it hands an object over and takes one
 * back. Where the rows live is this application's business.
 */
type AppSettingType = AppSettingRow["type"];

/** A row that cannot be read, told apart from a row holding `null`. */
const UNREADABLE = Symbol("unreadable");

const readSetting = (type: string, value: string) => {
  if (type === "null") return null;
  if (type === "string") return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return UNREADABLE;
  }

  // The declared type is CHECKED against what came back rather than trusted.
  if (type === "array") return Array.isArray(parsed) ? parsed : UNREADABLE;
  if (type === "object") return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : UNREADABLE;
  if (type === "number") return typeof parsed === "number" ? parsed : UNREADABLE;
  if (type === "boolean") return typeof parsed === "boolean" ? parsed : UNREADABLE;
  return UNREADABLE;
};

const typeOf = (value: unknown): AppSettingType => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
};

/** A string is stored RAW rather than JSON-encoded, so the table stays readable. */
const writeSetting = (value: unknown) => {
  const type = typeOf(value);
  if (type === "null") return { type, text: "null" };
  if (type === "string") return { type, text: String(value) };
  return { type, text: JSON.stringify(value) };
};

export const settings = {
  /**
   * Everything, in one read, and it runs before anything else at boot.
   *
   * A key that was never written is ABSENT rather than `null`, which is what tells
   * "never set" apart from "set to nothing".
   */
  async all() {
    const repo = await useRepo<AppSettingRow>(AppSettingEntity);
    const rows = await repo.find();

    const held: Record<string, unknown> = {};
    for (const row of rows) {
      const value = readSetting(row.type, row.value);
      // Skipped rather than fatal: a store that refuses to be read at all would stop
      // a boot over one bad line.
      if (value === UNREADABLE) console.warn(`[settings] ${row.key} is not a readable ${row.type} and was ignored`);
      else held[row.key] = value;
    }
    return held;
  },

  /** CREATE OR UPDATE each key given, in one transaction, and leave the others alone. */
  async upsertAll(values: Record<string, unknown>) {
    const entries = Object.entries(values);
    if (!entries.length) return;

    const source = await useSource();
    await source.transaction(async (manager) => {
      for (const [key, value] of entries) {
        const { type, text } = writeSetting(value);
        await manager.upsert(AppSettingEntity, { key, type, value: text }, ["key"]);
      }
    });
  },
};
