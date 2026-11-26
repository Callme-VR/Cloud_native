"use client";

import { useEffect } from "react";

const EXTENSION_ATTRS = ["bis_skin_checked", "bis_register"] as const;

type ExtensionGuardWindow = Window & {
  __cnHydrated?: boolean;
  __cnStopExtensionGuard?: () => void;
};

/**
 * Strips known browser-extension DOM attributes (e.g. Bitdefender bis_skin_checked)
 * before React hydrates so SSR markup matches client DOM attributes.
 */
export function stripExtensionAttributes(): void {
  if (typeof document === "undefined") return;

  for (const attr of EXTENSION_ATTRS) {
    const elements = document.querySelectorAll(`[${attr}]`);
    for (const el of elements) {
      el.removeAttribute(attr);
    }
  }

  for (const root of [document.documentElement, document.body]) {
    if (!root) continue;
    for (const attr of Array.from(root.attributes)) {
      if (
        attr.name.startsWith("__processed_") ||
        EXTENSION_ATTRS.includes(attr.name as (typeof EXTENSION_ATTRS)[number])
      ) {
        root.removeAttribute(attr.name);
      }
    }
  }
}

if (
  typeof window !== "undefined" &&
  !(window as ExtensionGuardWindow).__cnHydrated
) {
  stripExtensionAttributes();
}

/**
 * Marks hydration complete and disconnects the pre-hydration MutationObserver.
 */
export function HydrationGuard() {
  useEffect(() => {
    const win = window as ExtensionGuardWindow;
    win.__cnHydrated = true;
    win.__cnStopExtensionGuard?.();
  }, []);

  return null;
}

