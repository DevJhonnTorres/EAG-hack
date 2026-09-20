/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El motor de calculo vive en un paquete del monorepo y se consume compilado,
  // para que la interfaz y los tests ejecuten exactamente el mismo codigo.
  transpilePackages: ["@hashpool/orchestrator"],
};

export default nextConfig;
