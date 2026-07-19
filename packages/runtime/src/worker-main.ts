import { buildProductionRuntime } from "./composition.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";

const production = await buildProductionRuntime();
await production.runtime.worker.start();

installGracefulShutdown(production);
