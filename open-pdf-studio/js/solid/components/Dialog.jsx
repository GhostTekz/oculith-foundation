import { onMount, onCleanup } from 'solid-js';
import { nudgeOntoDevicePixels, snapDevice } from '../snap-device.js';
import { isTopmostDialog } from './dialog-stack.js';

// Track when the window last gained focus (shared across all Dialog instances)
let lastFocusTime = 0;
function onWindowFocus() { lastFocusTime = Date.now(); }
window.addEventListener('focus', onWindowFocus);

export default function Dialog(props) {
  let overlayRef;
  let dialogRef;
  let returnFocus;
  let isDragging = false;
  let pinned = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function onHeaderMouseDown(e) {
    if (e.target.closest('.modal-close-btn')) return;
    isDragging = true;
    const rect = dialogRef.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    const overlayRect = overlayRef.getBoundingClientRect();
    let newX = e.clientX - overlayRect.left - dragOffsetX;
    let newY = e.clientY - overlayRect.top - dragOffsetY;
    const dialogRect = dialogRef.getBoundingClientRect();
    newX = Math.max(0, Math.min(newX, overlayRect.width - dialogRect.width));
    newY = Math.max(0, Math.min(newY, overlayRect.height - dialogRect.height));
    pinned = true;
    dialogRef.style.left = snapDevice(newX) + 'px';
    dialogRef.style.top = snapDevice(newY) + 'px';
    dialogRef.style.right = 'auto';
    dialogRef.style.bottom = 'auto';
    dialogRef.style.transform = 'none';
    dialogRef.style.position = 'absolute';
  }

  function onMouseUp() {
    isDragging = false;
  }

  // Keep the dialog inside the window. Runs after mount (dialog may be larger
  // than a small window — CSS centering would push the title bar off-screen)
  // and on window resize (a dragged dialog keeps absolute coords). Top-left
  // wins the clamp so the draggable title bar always stays reachable.
  // Keep the title bar on screen, and land the window on a device pixel.
  // A flex-centered window stays centered across resizes. One that was
  // dragged, or that does not fit, stays pinned.
  function placeOnDevicePixels() {
    if (!dialogRef || !overlayRef) return;
    if (!pinned) {
      dialogRef.style.position = '';
      dialogRef.style.left = '';
      dialogRef.style.top = '';
      dialogRef.style.transform = 'none';
    }
    const overlayRect = overlayRef.getBoundingClientRect();
    const dialogRect = dialogRef.getBoundingClientRect();
    const curX = dialogRect.left - overlayRect.left;
    const curY = dialogRect.top - overlayRect.top;
    const maxX = Math.max(0, overlayRect.width - dialogRect.width);
    const maxY = Math.max(0, overlayRect.height - dialogRect.height);
    const clampedX = Math.min(Math.max(0, curX), maxX);
    const clampedY = Math.min(Math.max(0, curY), maxY);
    const offscreen = Math.abs(clampedX - curX) >= 0.5 || Math.abs(clampedY - curY) >= 0.5;
    if (pinned || offscreen) {
      pinned = true;
      dialogRef.style.position = 'absolute';
      dialogRef.style.left = snapDevice(clampedX) + 'px';
      dialogRef.style.top = snapDevice(clampedY) + 'px';
      dialogRef.style.right = 'auto';
      dialogRef.style.bottom = 'auto';
      dialogRef.style.transform = 'none';
      return;
    }
    nudgeOntoDevicePixels(dialogRef);
  }

  function onKeyDown(e) {
    // Only the topmost of stacked dialogs closes; the others and the
    // document-wide handlers after it do not see this Escape.
    if (e.key === 'Escape' && isTopmostDialog(dialogRef, document)) {
      e.stopImmediatePropagation();
      props.onClose?.();
    }
  }

  function keepTabInside(e) {
    if (e.key !== 'Tab') return;
    const controls = [...dialogRef.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    if (!controls.length) {
      e.preventDefault();
      dialogRef.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialogRef)) {
      e.preventDefault();
      first.focus();
    }
  }

  function triggerBump() {
    if (!dialogRef) return;
    // Remove class first to allow re-triggering
    dialogRef.classList.remove('bump');
    // Force reflow so the animation restarts
    void dialogRef.offsetWidth;
    dialogRef.classList.add('bump');
    // Play system alert sound via Rust backend
    if (window.__TAURI__?.core?.invoke) {
      window.__TAURI__.core.invoke('play_alert_sound').catch(() => {});
    }
  }

  function onOverlayMouseDown(e) {
    // If the window just gained focus from this click, only activate — don't interact
    if (Date.now() - lastFocusTime < 300) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Only trigger bump if click is directly on the overlay (not the dialog)
    if (e.target === overlayRef) {
      e.preventDefault();
      e.stopPropagation();
      triggerBump();
    }
  }

  function onOverlayDblClick(e) {
    // Block double-click on overlay from reaching the window behind
    if (e.target === overlayRef) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  onMount(() => {
    // Keep focus inside newly opened modals even when the action that opened
    // them came from a menu that has just been removed from view.
    const opener = document.activeElement;
    if (opener?.focus && opener !== document.body && !dialogRef.contains(opener)) {
      returnFocus = opener;
    }
    if (!dialogRef.contains(document.activeElement)) dialogRef.focus();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', placeOnDevicePixels);
    // Place after first layout (content height is only known then), before paint.
    requestAnimationFrame(placeOnDevicePixels);
  });

  onCleanup(() => {
    const hadFocus = dialogRef?.contains(document.activeElement);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', placeOnDevicePixels);
    // Solid removes the dialog after cleanup. Restore the opener only if focus
    // fell back to the document; a newly opened modal or an explicit focus
    // change takes precedence. Menus that were removed cannot receive focus.
    if (hadFocus && returnFocus) queueMicrotask(() => {
      const current = document.activeElement;
      const otherModal = [...document.querySelectorAll('.modal-overlay [role="dialog"]')]
        .some(modal => modal !== dialogRef && modal.getClientRects().length > 0 && !modal.contains(returnFocus));
      if (returnFocus.isConnected && returnFocus.getClientRects().length > 0 &&
          !otherModal &&
          (!current?.isConnected || current === document.body || current === document.documentElement)) {
        returnFocus.focus();
      }
    });
  });

  return (
    <div
      ref={overlayRef}
      class={`modal-overlay ${props.overlayClass || ''}`}
      style="display:flex"
      onMouseDown={onOverlayMouseDown}
      onDblClick={onOverlayDblClick}
    >
      <div
        ref={dialogRef}
        class={`modal-dialog ${props.dialogClass || ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={keepTabInside}
        onAnimationEnd={() => dialogRef?.classList.remove('bump')}
      >
        <div
          class={`modal-header ${props.headerClass || ''}`}
          onMouseDown={onHeaderMouseDown}
        >
          <h2>{props.title}</h2>
          <button class="modal-close-btn" onClick={() => props.onClose?.()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
        <div class={`modal-body ${props.bodyClass || ''}`}>
          {props.children}
        </div>
        {props.footer && (
          <div class={`modal-footer ${props.footerClass || ''}`}>
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}
