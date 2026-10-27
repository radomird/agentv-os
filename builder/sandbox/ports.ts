// Where the builder's way out is, on the sandbox's own loopback
// (builder/sandbox/start.ts forwards each to its socket file).
export const PROXY_PORT = 8080; // the filter, as HTTPS_PROXY
export const RELAY_PORT = 8081; // the key relay, as the provider's address
export const PAGE_PORT = 8082; // stage B's look at the signed-in pages
