import type { BrowserWindow, WebContentsView } from "electron";

import { browserBounds, devtoolsBounds, offscreenBounds } from "./browser-manager-layout";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserBounds } from "./browser-types";
import { fitBrowserResponsiveViewport } from "../../src/shared/browser-responsive";
import type { BrowserResponsiveGeometry } from "../../src/shared/browser-responsive";

/**
 * A WebContentsView paints above the renderer DOM and, on macOS, keeps its last
 * hit-test region even when hidden — so hiding one that overlaps the viewport
 * keeps it swallowing mouse clicks meant for React overlays. Parking it
 * off-screen *while still visible* before hiding moves the hit region off too.
 */
export function placeView(view: WebContentsView, visible: boolean, bounds: BrowserBounds): void {
  if (visible) {
    view.setVisible(true);
    view.setBounds(bounds);
  } else {
    view.setBounds(offscreenBounds(bounds));
    view.setVisible(false);
  }
}

/**
 * Idempotent parenting of native views to the main window, plus the
 * suppression flag: while a renderer overlay is open every view is fully
 * detached, because a merely hidden WebContentsView still sits in the macOS
 * hit-test chain and swallows clicks meant for the React overlay. Shared by the
 * Browser tab (`BrowserViewLayout`) and custom-tab guests (`PluginTabManager`).
 */
export class NativeViewAttachment {
  private suppressed = false;
  // Views currently parented to the window, so attach/detach stays idempotent
  // (the viewport ResizeObserver re-runs layout on every frame).
  private readonly attachedViews = new Set<WebContentsView>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  get isSuppressed(): boolean {
    return this.suppressed;
  }

  /** Record the new suppression state; returns true only when it changed. */
  setSuppressed(value: boolean): boolean {
    if (this.suppressed === value) return false;
    this.suppressed = value;
    return true;
  }

  isAttached(view: WebContentsView): boolean {
    return this.attachedViews.has(view);
  }

  /** Attach + place `view`, or detach it when `attached` is false or while suppressed. */
  layoutView(
    view: WebContentsView,
    attached: boolean,
    visible: boolean,
    bounds: BrowserBounds,
  ): void {
    if (!attached || this.suppressed) {
      this.detach(view);
      return;
    }
    if (!this.attach(view)) return;
    placeView(view, visible, bounds);
  }

  /** Fully detach a single view (used on close). Idempotent. */
  detach(view: WebContentsView): void {
    if (!this.attachedViews.delete(view)) return;
    this.liveWindow()?.contentView.removeChildView(view);
  }

  /** Detach every live view before its parent window is destroyed. */
  detachAll(): void {
    for (const view of [...this.attachedViews]) this.detach(view);
    this.suppressed = false;
  }

  private attach(view: WebContentsView): boolean {
    if (this.attachedViews.has(view)) return true;
    const win = this.liveWindow();
    if (!win) return false;
    win.contentView.addChildView(view);
    this.attachedViews.add(view);
    return true;
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.getWindow();
    return win && !win.isDestroyed() ? win : null;
  }
}

/**
 * Owns native-view attachment + geometry for every browser tab. While suppressed
 * (a renderer overlay is open) all views are fully detached from the window so
 * React dialogs and the address-bar autocomplete aren't occluded and — crucially
 * — can receive mouse clicks. A merely hidden WebContentsView still sits in the
 * macOS hit-test chain and swallows clicks meant for the React overlay.
 */
export class BrowserViewLayout {
  private readonly views: NativeViewAttachment;

  constructor(
    getWindow: () => BrowserWindow | null,
    private readonly syncResponsiveScale: (tab: ManagedTab, nativeScale: number) => void = () =>
      undefined,
  ) {
    this.views = new NativeViewAttachment(getWindow);
  }

  /** Record the new suppression state; returns true only when it changed. */
  setSuppressed(value: boolean): boolean {
    return this.views.setSuppressed(value);
  }

  /**
   * Position + visibility for all views from each scope's active tab + bounds,
   * devtools and suppression state. Single source of truth so activate /
   * resize / devtools / suppress all stay consistent.
   *
   * Tabs are isolated per feature scope: only the active tab of a scope whose
   * viewport is currently mounted (non-empty bounds) is attached and visible.
   * Tabs belonging to a backgrounded feature are fully detached, so a feature's
   * tabs never paint over another's.
   */
  apply(
    tabs: Map<string, ManagedTab>,
    activeByScope: Map<number | null, string>,
    boundsByScope: Map<number | null, BrowserBounds>,
    rendererZoomByScope: Map<number | null, number> = new Map(),
  ): void {
    const attached = !this.views.isSuppressed;
    for (const [id, tab] of tabs) {
      const scope = tab.metadata.scopeId;
      const scopeBounds = boundsByScope.get(scope);
      const hasBounds = !!scopeBounds && scopeBounds.width > 0 && scopeBounds.height > 0;
      const attachThis = attached && hasBounds;
      const active = attachThis && activeByScope.get(scope) === id;
      const devToolsOpen = tab.metadata.devToolsOpen;
      const base = scopeBounds ?? { x: 0, y: 0, width: 0, height: 0 };
      const responsive = this.responsiveGeometry(tab, base, rendererZoomByScope.get(scope) ?? 1);
      if (active) this.syncResponsiveScale(tab, responsive.nativeScale);
      this.views.layoutView(tab.view, attachThis, active, responsive.bounds);
      if (tab.devtoolsView) {
        const dtVisible = active && devToolsOpen;
        this.views.layoutView(tab.devtoolsView, attachThis, dtVisible, devtoolsBounds(base));
      }
    }
  }

  responsiveGeometry(
    tab: ManagedTab,
    base: BrowserBounds,
    rendererZoom = 1,
  ): BrowserResponsiveGeometry {
    return fitBrowserResponsiveViewport(
      browserBounds(base, tab.metadata.devToolsOpen),
      tab.metadata.responsive,
      rendererZoom,
    );
  }

  /** Fully detach a single view (used on close). Idempotent. */
  detach(view: WebContentsView): void {
    this.views.detach(view);
  }

  /** Detach every live view before its parent window is destroyed. */
  detachAll(): void {
    this.views.detachAll();
  }
}
