import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const barlow = Barlow_Condensed({ variable: "--font-barlow", subsets: ["latin"], weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: { default: "FootballAnalyzer: evidence-based match intelligence", template: "%s · FootballAnalyzer" },
  description:
    "Upload match footage and get tactical and player insights you can verify: every finding links back to the moments in the video it came from.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: "#c6f432",
              colorPrimaryForeground: "#0a1003",
              colorBackground: "#0d1422",
              colorForeground: "#f4f7fb",
              colorMutedForeground: "#9aa8bf",
              colorInput: "#131c2e",
              colorInputForeground: "#f4f7fb",
              colorBorder: "#2c3b58",
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
