import { buildProductionRuntime } from "./composition.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";

const production = await buildProductionRuntime();
await production.start();

installGracefulShutdown(production);
