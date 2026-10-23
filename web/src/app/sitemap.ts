import type { MetadataRoute } from "next";

const PAGES = ["", "/solutions", "/pricing", "/docs", "/faq", "/about", "/contact", "/ai-limitations", "/legal/privacy", "/legal/terms"];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  return PAGES.map((path) => ({
    url: `${origin}${path}`,
    changeFrequency: path.startsWith("/legal") ? "yearly" : "monthly",
    priority: path === "" ? 1 : 0.6,
  }));
}
