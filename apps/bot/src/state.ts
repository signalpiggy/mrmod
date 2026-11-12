import {
  connect,
  defaultSettings,
  DuplicateTracker,
  loadRules,
  loadSettings,
  VerdictCache,
  type DB,
  type RuleRow,
  type Settings,
} from "@mrmod/core";
import type postgres from "postgres";
import { log } from "./log.js";

/** Live config shared by all handlers; reloaded when the hub sends NOTIFY mrmod_config. */
export class BotState {
  settings: Settings = defaultSettings;
  rules: RuleRow[] = [];
  readonly duplicates = new DuplicateTracker();
  readonly verdicts = new VerdictCache();
  readonly db: DB;
  readonly sql: postgres.Sql;

  constructor() {
    const { db, sql } = connect();
    this.db = db;
    this.sql = sql;
  }

  async reload() {
    this.settings = await loadSettings(this.db);
    this.rules = await loadRules(this.db);
    log.info(`config loaded: globalMode=${this.settings.globalMode}, ${this.rules.length} rules`);
  }

  async listen() {
    await this.sql.listen("mrmod_config", () => {
      this.reload().catch((err) => log.error("config reload failed", err));
    });
  }
}
