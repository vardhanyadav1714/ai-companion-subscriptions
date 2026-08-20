import { env } from "./config/index.js";
import { connectMongo } from "./database.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  await connectMongo();
  const app = await buildApp();
  await app.listen({
    host: env.HOST,
    port: env.PORT
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

