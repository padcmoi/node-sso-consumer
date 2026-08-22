import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module";
import { SessionController } from "./session/session.controller";
import { XcoreModule } from "./sso/xcore.module";

@Module({
  // The order is the guarantee. `XcoreModule` depends on `DatabaseModule`, Nest
  // awaits every `onModuleInit` before any `onApplicationBootstrap`, and the schema
  // is built in the first while the pairing runs in the second - so the shelf exists
  // before anything reads it, with nothing to remember.
  imports: [DatabaseModule, XcoreModule],
  controllers: [SessionController],
})
export class AppModule {}
