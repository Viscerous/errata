import * as React from "react"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

type AsChildProps = { asChild?: boolean }

export type HintProps = React.HTMLAttributes<HTMLParagraphElement> &
  AsChildProps & {
    size?: "xs" | "sm"
  }

export const Hint = React.forwardRef<HTMLParagraphElement, HintProps>(
  function Hint({ asChild, size = "xs", className, ...props }, ref) {
    const Comp = asChild ? Slot.Root : "p"
    return (
      <Comp
        ref={ref}
        className={cn(
          size === "sm" ? "text-sm" : "text-xs",
          "text-muted-foreground",
          className
        )}
        {...props}
      />
    )
  }
)

export type CaptionProps = React.HTMLAttributes<HTMLParagraphElement> &
  AsChildProps & {
    size?: "xs" | "sm"
  }

export const Caption = React.forwardRef<HTMLParagraphElement, CaptionProps>(
  function Caption({ asChild, size = "xs", className, ...props }, ref) {
    const Comp = asChild ? Slot.Root : "p"
    return (
      <Comp
        ref={ref}
        className={cn(
          size === "sm" ? "text-sm" : "text-xs",
          "font-prose leading-relaxed text-muted-foreground",
          className
        )}
        {...props}
      />
    )
  }
)

export type MetaLabelProps = React.HTMLAttributes<HTMLSpanElement> & AsChildProps

export const MetaLabel = React.forwardRef<HTMLSpanElement, MetaLabelProps>(
  function MetaLabel({ asChild, className, ...props }, ref) {
    const Comp = asChild ? Slot.Root : "span"
    return (
      <Comp
        ref={ref}
        className={cn("text-ui-caption text-muted-foreground", className)}
        {...props}
      />
    )
  }
)

export type EyebrowProps = React.HTMLAttributes<HTMLSpanElement> & AsChildProps

export const Eyebrow = React.forwardRef<HTMLSpanElement, EyebrowProps>(
  function Eyebrow({ asChild, className, ...props }, ref) {
    const Comp = asChild ? Slot.Root : "span"
    return (
      <Comp
        ref={ref}
        className={cn(
          "text-ui-label font-medium uppercase tracking-[0.16em] text-muted-foreground",
          className
        )}
        {...props}
      />
    )
  }
)

export type MetricProps = React.HTMLAttributes<HTMLSpanElement> & AsChildProps

export const Metric = React.forwardRef<HTMLSpanElement, MetricProps>(
  function Metric({ asChild, className, ...props }, ref) {
    const Comp = asChild ? Slot.Root : "span"
    return (
      <Comp
        ref={ref}
        className={cn(
          "text-ui-label font-mono tabular-nums text-muted-foreground",
          className
        )}
        {...props}
      />
    )
  }
)

export type EmptyHintProps = React.HTMLAttributes<HTMLParagraphElement> &
  AsChildProps & {
    size?: "xs" | "sm"
  }

export const EmptyHint = React.forwardRef<HTMLParagraphElement, EmptyHintProps>(
  function EmptyHint({ asChild, size = "xs", className, ...props }, ref) {
    const Comp = asChild ? Slot.Root : "p"
    return (
      <Comp
        ref={ref}
        className={cn(
          size === "sm" ? "text-sm" : "text-xs",
          "italic text-muted-foreground",
          className
        )}
        {...props}
      />
    )
  }
)
