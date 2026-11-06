import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-fg text-ink hover:opacity-90 active:opacity-80",
  secondary: "border border-line-strong text-fg hover:bg-raised active:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-fg active:bg-raised",
};

export const buttonClass = (variant: Variant = "primary", className?: string) =>
  cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-[opacity,background-color,color] disabled:pointer-events-none disabled:opacity-50",
    VARIANTS[variant],
    className,
  );

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export function Button({ variant, className, type = "button", ...props }: Props) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}
