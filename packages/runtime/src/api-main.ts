import { buildProductionRuntime } from "./composition.js";

const production = await buildProductionRuntime();
await production.start();

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await production.stop();
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
