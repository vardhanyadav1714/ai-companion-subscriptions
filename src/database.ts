import mongoose from "mongoose";

import { env } from "./config/index.js";

export async function connectMongo(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DATABASE
  });
}

export function mongoState(): string {
  return mongoose.connection.readyState === 1 ? "connected" : "disconnected";
}

