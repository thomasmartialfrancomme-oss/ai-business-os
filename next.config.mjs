/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Origines autorisées à solliciter le serveur de développement (preview sandbox, tunnels).
  allowedDevOrigins: ["*.e2b.app", "*.ngrok-free.app", "localhost:3000", "127.0.0.1:3000"],
  experimental: {
    // Les webhooks Stripe exigent le corps brut : aucune transformation du body ici.
  },
  async headers() {
    return [
      {
        // Les endpoints de webhook et d'API ne doivent jamais être mis en cache.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
