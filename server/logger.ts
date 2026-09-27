import pino from "pino";
import { env } from "./config";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: ["token", "apiKey", "authorization", "headers", "request", "response"],
  ...(env.NODE_ENV === "production"
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});
