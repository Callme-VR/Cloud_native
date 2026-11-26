import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { HydrationGuard } from "@/components/hydration-guard";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cloud Native - Autonomous AI Coding Harness",
  description:
    "Cloud Native autonomous coding agent platform with disposable Docker sandboxes, live ReAct traces, and Neon persistence.",
  icons: {
    icon: "/cloud-native-logo.svg",
    shortcut: "/cloud-native-logo.svg",
    apple: "/cloud-native-logo.svg",
  },
};

const EXTENSION_GUARD_SCRIPT = `(() => {
  try {
    if (window.__cnHydrated) return;
    const isExtAttr = (name) =>
      name === "bis_skin_checked" ||
      name === "bis_register" ||
      name.startsWith("__processed_");

    const cleanEl = (el) => {
      if (!el || !el.attributes) return;
      for (let i = el.attributes.length - 1; i >= 0; i--) {
        const name = el.attributes[i].name;
        if (isExtAttr(name)) el.removeAttribute(name);
      }
    };

    const cleanAll = () => {
      const nodes = document.querySelectorAll("[bis_skin_checked],[bis_register]");
      for (let i = 0; i < nodes.length; i++) cleanEl(nodes[i]);
      cleanEl(document.documentElement);
      cleanEl(document.body);
    };

    cleanAll();

    const seen = new WeakMap();
    let total = 0;
    const observer = new MutationObserver((mutations) => {
      if (window.__cnHydrated) {
        observer.disconnect();
        return;
      }
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === "attributes" && m.attributeName && isExtAttr(m.attributeName)) {
          const target = m.target;
          if (!(target instanceof Element)) continue;
          const count = (seen.get(target) || 0) + 1;
          if (count > 5 || ++total > 5000) {
            observer.disconnect();
            return;
          }
          seen.set(target, count);
          target.removeAttribute(m.attributeName);
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      subtree: true,
    });

    window.__cnStopExtensionGuard = () => observer.disconnect();
    window.addEventListener(
      "load",
      () => {
        window.__cnHydrated = true;
        observer.disconnect();
      },
      { once: true }
    );
  } catch {}
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", inter.variable)}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: EXTENSION_GUARD_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <HydrationGuard />
        {children}
      </body>
    </html>
  );
}
