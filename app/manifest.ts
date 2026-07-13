import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FLOCKYOU",
    short_name: "FLOCKYOU",
    description: "Camera-aware driving navigation.",
    start_url: "/",
    display: "standalone",
    background_color: "#07090c",
    theme_color: "#07090c",
    orientation: "any",
    icons: [
      {
        src: "/icons/flockyou-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icons/flockyou-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icons/flockyou-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      }
    ]
  };
}
