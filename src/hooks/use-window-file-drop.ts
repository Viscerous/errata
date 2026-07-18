import { useEffect, useRef, useState } from 'react'
import {
  collectDroppedFileDetails,
  type FileDropDetails,
} from '@/lib/file-drop'

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
  onDrop: (files: File[], details: FileDropDetails) => void | Promise<void>,
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
      const transfer = e.dataTransfer
      if (!transfer) return

      // Capture entry handles synchronously. Chromium releases access to the
      // DataTransfer after this event returns, but the handles remain readable.
      const rootEntries = Array.from(transfer.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.webkitGetAsEntry?.() ?? null)
        .filter((entry): entry is FileSystemEntry => entry !== null)
      const files = Array.from(transfer.files)

      if (rootEntries.length === 0 && files.length === 0) return
      void collectDroppedFileDetails(rootEntries, files)
        .catch(() => collectDroppedFileDetails([], files))
        .then((details) => onDropRef.current(files, details))
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
