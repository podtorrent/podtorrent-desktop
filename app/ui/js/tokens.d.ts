// Types for js/tokens.js (the app is buildless JS; this file documents the token contract).
export type SemanticColor = "serving" | "active" | "degraded" | "gap" | "you" | "net";
export declare const space: Record<1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12, number>;
export declare const radius: { sm: 6; md: 10; lg: 14 };
export declare const type: Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>;
export declare const motion: {
  duration: { fast: number; base: number; slow: number };
  spring: Record<"snappy" | "smooth" | "gentle", { k: number; c: number }>;
};
export declare const fonts: { ui: string; mono: string };
export interface ResolvedColors extends Record<SemanticColor, string> {
  accent: string; fg1: string; fg2: string; fg3: string; fg4: string;
  line1: string; line2: string; bg: string; elev1: string; elev2: string; sunken: string;
}
export declare function colors(): ResolvedColors;
export declare function invalidateColors(): void;
export declare function alpha(hex: string, a: number): string;
