import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function ComposerFrame({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'relative rounded-xl border border-border/30 bg-card shadow-lg transition-[border-color,box-shadow] duration-200 hover:border-border/50 focus-within:border-primary/25 focus-within:ring-1 focus-within:ring-primary/10',
        className,
      )}
      {...props}
    />
  )
}

export function ComposerTextarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'block w-full resize-none border-0 bg-transparent px-4 py-2 font-prose text-base leading-relaxed text-foreground outline-none placeholder:italic placeholder:text-muted-foreground disabled:opacity-40',
        className,
      )}
      {...props}
    />
  )
}

export function ComposerToolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center justify-between gap-2 px-3 pb-2.5 pt-0.5', className)} {...props} />
}
