import "reflect-metadata";
import { DataSource } from "typeorm";
import { AppSettingEntity, NoteEntity, SsoAccountEntity } from "./entities";

/**
 * The connection, built once per process.
 *
 * `synchronize: true`, and it is a POC decision rather than a recommendation: the
 * schema is derived from the entities at boot, so there is no migration to write by
 * hand - which is the rule anyway, since only `migration:generate` should ever
 * produce one. A real deployment turns this off and runs generated migrations.
 */
let source: DataSource | undefined;

export async function useSource() {
  if (!source) {
    const config = useRuntimeConfig();
    source = new DataSource({
      type: "mariadb",
      host: config.db.host,
      port: Number(config.db.port),
      username: config.db.user,
      password: config.db.password,
      database: config.db.name,
      charset: "utf8mb4_general_ci",
      synchronize: true,
      logging: false,
      entities: [AppSettingEntity, SsoAccountEntity, NoteEntity],
    });
  }
  if (!source.isInitialized) await source.initialize();
  return source;
}

export const useRepo = async <T extends object>(entity: Parameters<DataSource["getRepository"]>[0]) =>
  (await useSource()).getRepository<T>(entity);
