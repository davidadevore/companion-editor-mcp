import type { CompanionClient } from './companion-client.js';
import type { CompanionConfigClient } from './companion-config.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Allowlist } from './safety.js';

export interface AppContext {
  readonly config: Config;
  readonly client: CompanionClient;
  readonly configClient: CompanionConfigClient;
  readonly logger: Logger;
  readonly allowlist: Allowlist;
}
