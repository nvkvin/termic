import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-[var(--color-accent-deep)] text-white hover:brightness-110 border border-[var(--color-accent-deep)]",
        secondary: "bg-[var(--color-bg-2)] text-[var(--color-fg)] hover:border-[var(--color-accent-soft)] border border-[var(--color-border)]",
        ghost: "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
        // Lit for as long as the menu or popover it opened is up. Keyed on
        // aria-expanded, which only the menu sets: these triggers usually sit
        // inside a Tip, and a tooltip trigger writes data-state as well.
        icon: "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] aria-expanded:bg-[var(--color-hover)] aria-expanded:text-[var(--color-fg)] rounded-md",
        danger: "bg-[var(--color-err)]/15 text-[var(--color-err)] border border-[var(--color-err)]/30 hover:bg-[var(--color-err)]/25",
      },
      size: {
        sm: "h-7 px-2.5 text-[13.5px]",
        md: "h-8 px-3 text-[14px]",
        lg: "h-9 px-4 text-[13px]",
        icon: "h-7 w-7 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(
  ({ className, variant, size, type = "button", ...rest }, ref) =>
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...rest} />,
);
Button.displayName = "Button";
