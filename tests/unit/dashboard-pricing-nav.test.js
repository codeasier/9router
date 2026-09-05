import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";
import { getPageInfo } from "../../src/shared/utils/dashboardPageInfo.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readRepo(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function sliceSystemItems(sidebarSource) {
  const start = sidebarSource.indexOf("const systemItems = [");
  expect(start).toBeGreaterThan(-1);
  const end = sidebarSource.indexOf("];", start);
  expect(end).toBeGreaterThan(start);
  return sidebarSource.slice(start, end + 2);
}

describe("dashboard pricing page discoverability (#16)", () => {
  it("lives in the dashboard route group and still opens PricingModal", () => {
    const pagePath = join(root, "src/app/(dashboard)/dashboard/pricing/page.js");
    expect(existsSync(pagePath)).toBe(true);
    const page = readFileSync(pagePath, "utf8");
    expect(page).toContain("PricingModal");
    expect(page).not.toContain("useRouter");
  });

  it("is linked from the System sidebar section", () => {
    const systemItems = sliceSystemItems(readRepo("src/shared/components/Sidebar.js"));
    expect(systemItems).toContain('href: "/dashboard/pricing"');
    expect(systemItems).toContain('label: "Pricing"');
  });

  it("fills the dashboard header title instead of leaving it blank", () => {
    expect(getPageInfo("/dashboard/pricing")).toMatchObject({
      title: "Pricing",
      icon: "payments",
    });
    expect(getPageInfo("/dashboard/quota").title).toBe("Quota Tracker");
    expect(getPageInfo("/dashboard/profile").title).toBe("Settings");
  });

  it("uses opaque theme surface colors instead of undefined bg-bg-* tokens", () => {
    const source = readRepo("src/shared/components/PricingModal.js");
    expect(source).toContain("relative w-full max-w-6xl");
    expect(source).toContain("bg-surface");
    expect(source).not.toContain("bg-bg-base");
    expect(source).not.toContain("bg-bg-subtle");
    expect(source).not.toContain("bg-bg-hover");
  });

  it("redirects the legacy settings URL to the new path", async () => {
    const redirects = await nextConfig.redirects();
    expect(redirects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "/dashboard/settings/pricing",
        destination: "/dashboard/pricing",
        permanent: true,
      }),
    ]));
    expect(existsSync(join(root, "src/app/dashboard/settings/pricing/page.js"))).toBe(false);
  });
});
