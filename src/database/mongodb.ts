import mongoose from "mongoose";

import { env } from "../config/env.js";

export async function connectMongo(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DATABASE,
    serverSelectionTimeoutMS: 8000
  });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
