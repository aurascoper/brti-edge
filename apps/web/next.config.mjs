/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@polyterminal/types",
    "@polyterminal/ui",
    "@polyterminal/market-state",
    "@polyterminal/signals",
    "@polyterminal/polymarket-client",
  ],
  webpack: (config) => {
    config.externals.push(
      "pino-pretty",
      "lokijs",
      "encoding",
      "@react-native-async-storage/async-storage",
    );
    return config;
  },
};

export default nextConfig;
