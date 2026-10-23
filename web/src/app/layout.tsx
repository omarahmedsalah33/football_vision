import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Barlow_Condensed, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Brand typography: primary (headings, architectural), secondary (body/UI), special (data).
const barlow = Barlow_Condensed({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  style: ["normal", "italic"],
});
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
// Variable font: all weights in one file.
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Football Vision: Train. Measure. Perform. Discover.", template: "%s · Football Vision" },
  description:
    "Professional-grade football analysis, made accessible to every team, academy and player. Upload match footage and get insight you can check against the video.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {/* dynamic: renders per request so Clerk's scripts receive the CSP nonce. */}
        <ClerkProvider
          dynamic
          appearance={{
            variables: {
              colorPrimary: "#d9f67d",
              colorPrimaryForeground: "#0b1f17",
              colorBackground: "#123528",
              colorForeground: "#f5f7f2",
              colorMutedForeground: "#bfcec7",
              colorInput: "#0b1f17",
              colorInputForeground: "#f5f7f2",
              colorBorder: "#2c5c46",
              colorDanger: "#ff7a6b",
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
