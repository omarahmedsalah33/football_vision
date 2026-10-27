import type { GameAttribute, GameRatings } from "@/lib/game-ratings";
export type RatingKey = GameAttribute["key"];
export type GameRatingsView = GameRatings;
export const RATING_ORDER: RatingKey[] = ["PAC", "SHO", "PAS", "DRI", "DEF", "PHY"];
export function ratingsOf(stat: object): GameRatingsView | null {
  const r = (stat as { ratings?: GameRatingsView }).ratings;
  return r && Array.isArray(r.attributes) ? r : null;
}
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => [...w][0] ?? "").join("").toUpperCase();
