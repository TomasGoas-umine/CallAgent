import { configureWebhook } from './lib/configure-webhook.js';
import { env } from '../src/utils/env.js';
await configureWebhook(env.publicBaseUrl);
