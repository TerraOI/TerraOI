// OpenNext for Cloudflare. No incremental (ISR) cache yet: tenant pages are
// private/no-store (plan §4.4). Add a cache override only with an ADR.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
