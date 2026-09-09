import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared chrome for full-height workspace surfaces. These components own the
 * visual boundary and spacing only; feature panels keep their own behaviour.
 */

function WorkspaceHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        'flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-border/50 bg-panel/90 px-4 py-2.5 backdrop-blur-md sm:px-6',
        className,
      )}
      {...props}
    />
  )
}

function WorkspaceTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="workspace-title"
      className={cn('truncate font-display text-lg font-normal leading-tight tracking-tight', className)}
      {...props}
    />
  )
}

function WorkspaceToolbar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="workspace-toolbar"
      className={cn('flex shrink-0 items-center gap-1', className)}
      {...props}
    />
  )
}

function WorkspaceDivider({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="workspace-divider"
      className={cn('mx-1 h-4 w-px shrink-0 bg-border/50', className)}
      {...props}
    />
  )
}

function WorkspaceFooter({ className, ...props }: React.ComponentProps<'footer'>) {
  return (
    <footer
      data-slot="workspace-footer"
      className={cn(
        'flex min-h-9 shrink-0 items-center justify-between gap-4 border-t border-border/40 bg-panel-muted/80 px-4 py-2 sm:px-6',
        className,
      )}
      {...props}
    />
  )
}

function WorkspaceRail({ className, ...props }: React.ComponentProps<'aside'>) {
  return (
    <aside
      data-slot="workspace-rail"
      className={cn('flex min-h-0 shrink-0 flex-col border-l border-border/50 bg-panel-muted/85', className)}
      {...props}
    />
  )
}

function WorkspaceRailHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="workspace-rail-header"
      className={cn('shrink-0 border-b border-border/30 px-3 py-3', className)}
      {...props}
    />
  )
}

export {
  WorkspaceDivider,
  WorkspaceFooter,
  WorkspaceHeader,
  WorkspaceRail,
  WorkspaceRailHeader,
  WorkspaceTitle,
  WorkspaceToolbar,
}
