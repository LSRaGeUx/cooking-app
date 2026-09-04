import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Bricolage_Grotesque, JetBrains_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { ServiceWorker } from "@/components/service-worker";
import { defaultTheme, isTheme, THEME_COOKIE, themeColor } from "@/lib/theme";
import "./globals.css";

/*
 * One typeface, and a stamp.
 *
 * Bricolage Grotesque carries the whole interface: it has a width axis and an
 * optical size axis, so the same family sets a 15px label and a 140px week
 * number, condensed hard at poster sizes and normal at reading sizes. A second
 * family would be a second voice, and this design has one.
 *
 * JetBrains Mono is a stamp, not a voice: only strings a machine wrote or
 * measured exactly, such as the MCP endpoint, a tool name or a shell command.
 *
 * next/font downloads both at build time and serves them from this origin, so
 * a self-hosted install makes no request to Google at runtime.
 */
const grotesk = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  display: "swap",
  variable: "--font-grotesk",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-face",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");

  return {
    title: t("name"),
    description: t("tagline"),
    manifest: "/manifest.webmanifest",
    // The grocery list is used one-handed in a shop, so the application is
    // installable and opens without browser chrome.
    appleWebApp: { capable: true, title: t("name"), statusBarStyle: "default" },
    /*
     * The SVG is the tab favicon and iOS accepts it for neither job on the home
     * screen: not as apple-touch-icon, and not out of the manifest. Left to
     * itself it takes a screenshot of the page and uses that as the tile, so
     * the mark is rasterised to PNG in public/ as well.
     *
     * apple-touch-icon.png is square and opaque on purpose. iOS masks the icon
     * with its own shape, so the rounded corners the SVG draws would be cut
     * twice, and a transparent corner is composited onto black rather than
     * onto the tile.
     */
    icons: {
      icon: [
        { url: "/icon.svg", type: "image/svg+xml" },
        { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      ],
      apple: { url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" },
    },
  };
}

/*
 * A function rather than the static object, because the theme is a cookie and
 * not a media query, so the colour the operating system is told to paint has to
 * be resolved per request like the ground is. See src/lib/theme.ts for both the
 * reason the theme is a cookie and the reason this value is the panel.
 */
export async function generateViewport(): Promise<Viewport> {
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(stored) ? stored : defaultTheme;

  return {
    /*
     * The shell paints edge to edge and each bar pads itself back out of the
     * notch and the home indicator. Without this every env(safe-area-inset-*)
     * resolves to zero, so the padding that keeps the bottom bar clear of the
     * home indicator silently does nothing. See .shell in globals.css.
     */
    viewportFit: "cover",
    themeColor: themeColor[theme],
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  // Resolved on the server so the first byte carries the right ground. See
  // src/lib/theme.ts for why this is not a media query.
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(stored) ? stored : defaultTheme;

  return (
    <html
      lang={locale}
      data-theme={theme}
      className={`${grotesk.variable} ${mono.variable}`}
    >
      <body>
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
