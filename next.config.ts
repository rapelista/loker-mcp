import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pastikan folder profile/ dan private/ (CV, portofolio) ikut terbundel
  // ke serverless function di Vercel, karena dibaca lewat fs saat runtime.
  outputFileTracingIncludes: {
    "/**": ["./profile/**/*", "./private/**/*"],
  },
};

export default nextConfig;
