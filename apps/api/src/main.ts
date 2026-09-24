import { resolve } from "node:path";
import { createApplication } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const databasePath = process.env.DATABASE_PATH ?? resolve(process.cwd(), "var/recruitment.sqlite");
const webRoot = process.env.WEB_ROOT ?? resolve(process.cwd(), "build/web");

const application = await createApplication({
  databasePath,
  webRoot,
  log: (record) => console.log(JSON.stringify(record))
});
application.server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "server-listening", host, port }));
});

async function shutdown(): Promise<void> {
  await application.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
