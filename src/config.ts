import { existsSync, readFileSync } from "fs";

export interface ORIStoneConfig {
  oriApiBase: string;
  oriApiKey: string;
}

export function loadConfig(): ORIStoneConfig {
  // Priority: .env file > environment variables > defaults
  if (existsSync(".env")) {
    const lines = readFileSync(".env", "utf-8").split("\n");
    for (const line of lines) {
      const [k, ...rest] = line.split("=");
      if (k && rest.length) process.env[k.trim()] = rest.join("=").trim();
    }
  }

  return {
    oriApiBase: process.env.ORI_API_BASE ?? "https://glm.thynaptic.com/v1",
    oriApiKey:  process.env.ORI_API_KEY  ?? "",
  };
}
