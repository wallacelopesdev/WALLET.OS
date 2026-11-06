export const CATEGORY_KINDS = ["expense", "income"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  expense: "Despesa",
  income: "Receita",
};

export const CATEGORY_ICON_NAMES = [
  "tag",
  "utensils",
  "shopping-cart",
  "shopping-bag",
  "house",
  "car",
  "bike",
  "plane",
  "heart-pulse",
  "dumbbell",
  "graduation-cap",
  "party-popper",
  "gamepad-2",
  "smile",
  "gift",
  "paw-print",
  "baby",
  "repeat",
  "receipt",
  "zap",
  "smartphone",
  "banknote",
  "laptop",
  "trending-up",
  "store",
  "circle-ellipsis",
] as const;

export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number];

export const CATEGORY_COLORS = [
  "#fafafa",
  "#a3a3a3",
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#4ade80",
  "#2dd4bf",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
] as const;

export const DEFAULT_CATEGORY_ICON: CategoryIconName = "tag";
export const DEFAULT_CATEGORY_COLOR = "#a3a3a3";
