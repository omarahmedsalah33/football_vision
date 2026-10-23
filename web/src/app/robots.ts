import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  return {
    // The authenticated app and the API are private; keep them out of search engines.
    rules: [{ userAgent: "*", allow: "/", disallow: ["/app", "/api"] }],
    sitemap: `${origin}/sitemap.xml`,
  };
}
