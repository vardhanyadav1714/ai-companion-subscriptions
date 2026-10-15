import { expect, it } from "vitest";
import { trustedProxySetting } from "./trusted-proxies.js";

it("does not trust forwarded addresses by default", () => {
  expect(trustedProxySetting("")).toBe(false);
});
it("accepts only explicit proxy addresses/ranges", () => {
  expect(trustedProxySetting("192.0.2.1/32, ::1")).toEqual(["192.0.2.1/32", "::1"]);
  for (const raw of ["0.0.0.0/0", "::/0", "true", "*", "localhost", "::1/129"]) {
    expect(() => trustedProxySetting(raw)).toThrow();
  }
});
