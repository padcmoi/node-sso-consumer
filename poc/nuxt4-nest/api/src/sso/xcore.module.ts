import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { CredentialsStore } from "./credentials.store";
import { XcoreExceptionFilter } from "./xcore.filter";
import { XcoreGuard } from "./xcore.guard";
import { XcoreService } from "./xcore.service";
import { SettingsStore } from "./settings.store";

/**
 * The bridge, the guard and the filter. The library's seven routes are NOT here.
 *
 * They are mounted in `main.ts`, and that is not a preference - see the comment
 * there. `configure(consumer)` with `forRoutes("*")`, which is what `docs/nestjs.md`
 * describes, mounts them at a path, and Express strips a mount path off `req.url`
 * before the handler sees it: the library then reads `/` for every request, matches
 * none of its six, and passes all of them on to a `404` from Nest. Nothing logs
 * anything, and the sign-in route simply does not exist.
 */
@Module({
  providers: [XcoreService, XcoreGuard, SettingsStore, CredentialsStore, { provide: APP_FILTER, useClass: XcoreExceptionFilter }],
  exports: [XcoreService, XcoreGuard],
})
export class XcoreModule {}
