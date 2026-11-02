/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@agent-tax-research/database"],
  webpack: (config) => {
    // The database package uses NodeNext ".js" specifiers pointing at .ts sources.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};
