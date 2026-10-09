import { beforeEach, describe, expect, it } from "vitest";
import { resetStateForTests, getState } from "../src/store.js";

describe("ticket inventory rules", () => {
  beforeEach(() => resetStateForTests());

  it("starts with available inventory and keeps reserved + sold within total", () => {
    const event = getState().events[0]!;
    const ticket = event.tickets[0]!;
    expect(ticket.total - ticket.reserved - ticket.sold).toBeGreaterThan(0);
    expect(ticket.reserved + ticket.sold).toBeLessThanOrEqual(ticket.total);
  });
});
