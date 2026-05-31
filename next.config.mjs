/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` is a native-ish Node module — keep it external to the server bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
