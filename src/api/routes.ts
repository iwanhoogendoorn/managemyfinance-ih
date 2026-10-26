/**
 * Every endpoint group the local API serves — one line per module.
 *
 * Each module under src/api/ exports `register(router: Router): void` and adds its routes there; it is
 * switched on by re-exporting that function below under the group's name. That single line is the
 * only shared code a new group touches, so groups written in parallel don't step on each other, and
 * buildRouter() in server.ts picks up whatever is listed here without being edited itself.
 *
 * Keep the list alphabetical. Two modules claiming the same METHOD + path throws at startup.
 */
export { register as accounts } from "./accountsRoutes";
export { register as categories } from "./categoriesRoutes";
export { register as health } from "./health";
export { register as merchants } from "./merchantsRoutes";
export { register as rules } from "./rulesRoutes";
