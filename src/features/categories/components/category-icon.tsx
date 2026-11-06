import {
  Baby,
  Banknote,
  Bike,
  Car,
  CircleEllipsis,
  Dumbbell,
  Gamepad2,
  Gift,
  GraduationCap,
  HeartPulse,
  House,
  Laptop,
  PartyPopper,
  PawPrint,
  Plane,
  Receipt,
  Repeat,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Smile,
  Store,
  Tag,
  TrendingUp,
  Utensils,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CATEGORY_COLOR,
  type CategoryIconName,
} from "../constants";

export const CATEGORY_ICONS: Record<CategoryIconName, LucideIcon> = {
  tag: Tag,
  utensils: Utensils,
  "shopping-cart": ShoppingCart,
  "shopping-bag": ShoppingBag,
  house: House,
  car: Car,
  bike: Bike,
  plane: Plane,
  "heart-pulse": HeartPulse,
  dumbbell: Dumbbell,
  "graduation-cap": GraduationCap,
  "party-popper": PartyPopper,
  "gamepad-2": Gamepad2,
  smile: Smile,
  gift: Gift,
  "paw-print": PawPrint,
  baby: Baby,
  repeat: Repeat,
  receipt: Receipt,
  zap: Zap,
  smartphone: Smartphone,
  banknote: Banknote,
  laptop: Laptop,
  "trending-up": TrendingUp,
  store: Store,
  "circle-ellipsis": CircleEllipsis,
};

export function CategoryIcon({
  icon,
  color,
  archived,
  className,
}: {
  icon: string | null;
  color: string | null;
  archived?: boolean;
  className?: string;
}) {
  const Icon = CATEGORY_ICONS[icon as CategoryIconName] ?? Tag;
  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised",
        className,
      )}
      style={{ color: archived ? "#5c5c5c" : (color ?? DEFAULT_CATEGORY_COLOR) }}
    >
      <Icon aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.8} />
    </span>
  );
}
