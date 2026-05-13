import type { Level } from "./types.js"

const levelRanks: Record<Level, number> = {
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

const pinoLevels: Record<Level, string> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  none: "silent",
}

export function shouldLog(currentLevel: Level, targetLevel: Level): boolean {
  return levelRanks[currentLevel] >= levelRanks[targetLevel]
}

export function parseLevel(env?: string): Level {
  if (!env) return "info"
  const normalized = env.toLowerCase().trim()
  if (normalized in levelRanks) return normalized as Level
  // Accept pino aliases so callers porting from pino don't get silence
  // on familiar level names. trace is finer-grained than debug; we map
  // it to debug. fatal is coarser than error; we map it to error.
  if (normalized === "trace") return "debug"
  if (normalized === "fatal") return "error"
  return "info"
}

export function toPinoLevel(level: Level): string {
  return pinoLevels[level]
}

export function getLevelRank(level: Level): number {
  return levelRanks[level]
}
