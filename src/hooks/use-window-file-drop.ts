import { useEffect, useRef, useState } from 'react'

/**
 * Window-wide file drag-and-drop. Returns whether a file drag is currently over
 * the window (drive a drop overlay with it) and invokes `onDrop` with the
 * dropped files.
 *
 * Overlay visibility is driven by `dragover` as a keepalive rather than a
 * dragenter/dragleave counter. The counter approach wedges the overlay open
 * whenever the balancing `dragleave` is missed — which happens when a file drag
 * is cancelled over the window (Esc, or dropped outside it) or when the platform
 * omits `Files` from `dataTransfer.types` on the exit event (seen under
 * Electron/Chromium). `dragover` fires continuously while a drag is live and
 * stops the instant it ends by ANY means, so a short watchdog reliably clears
 * the overlay. A null-`relatedTarget` `dragleave` (the pointer left the window)
 * hides it immediately for the common case, so the watchdog is only ever a
 * safety net for the cancel-in-place path.
 */
export function useWindowFileDrop(
  onDrop: (files: File[]) => void | Promise<void>,
): boolean {
  const [isDragging, setIsDragging] = useState(false)
  // Keep the latest handler without re-subscribing the listeners every render.
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const clearHideTimer = () => {
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer)
        hideTimer = undefined
      }
    }
    const dragHasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

    const handleDragOver = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault() // required for the drop event to fire
      setIsDragging(true)
      clearHideTimer()
      hideTimer = setTimeout(() => setIsDragging(false), 700)
    }

    const handleDragLeave = (e: DragEvent) => {
      // Only the window-exit dragleave has a null relatedTarget; element-to-element
      // crossings carry the entered node, so this never flickers mid-drag.
      if (e.relatedTarget === null) {
        clearHideTimer()
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      clearHideTimer()
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) void onDropRef.current(Array.from(files))
    }

    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)
    return () => {
      clearHideTimer()
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [])

  return isDragging
}
