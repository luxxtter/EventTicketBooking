import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { z } from "zod";
import { availableFor, eventById, expireHolds, getState, publicEvent, saveState, type Booking, type Hold } from "./store.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "100kb" }));

const asyncRoute = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const holdSchema = z.object({
  userId: z.string().min(3).max(100),
  eventId: z.string().min(1),
  ticketTypeId: z.string().min(1),
  quantity: z.number().int().min(1).max(6),
  idempotencyKey: z.string().min(8).max(120)
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "event-ticket-booking-api", time: new Date().toISOString() }));

app.get("/api/events", (req, res) => {
  expireHolds();
  const q = String(req.query.q || "").trim().toLowerCase();
  const category = String(req.query.category || "").trim().toLowerCase();
  const city = String(req.query.city || "").trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(24, Math.max(1, Number(req.query.limit || 12)));
  const all = getState().events.filter(e =>
    (!q || [e.title, e.description, e.venue, e.city, e.category].some(v => v.toLowerCase().includes(q))) &&
    (!category || e.category.toLowerCase() === category) &&
    (!city || e.city.toLowerCase().includes(city))
  ).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  res.json({ items: all.slice((page - 1) * limit, page * limit).map(publicEvent), total: all.length, page, limit });
});

app.get("/api/events/:id", (req, res) => {
  expireHolds();
  const event = getState().events.find(e => e.id === req.params.id || e.slug === req.params.id);
  if (!event) return res.status(404).json({ error: "Event not found" });
  return res.json(publicEvent(event));
});

app.get("/api/events/:id/availability", (req, res) => {
  expireHolds();
  const event = eventById(req.params.id);
  if (!event) return res.status(404).json({ error: "Event not found" });
  res.json({ eventId: event.id, tickets: event.tickets.map(t => ({ id: t.id, available: availableFor(t) })) });
});

app.post("/api/holds", (req, res) => {
  expireHolds();
  const parsed = holdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid hold request", details: parsed.error.flatten() });
  const input = parsed.data;
  const state = getState();
  const existing = state.holds.find(h => h.idempotencyKey === input.idempotencyKey && h.userId === input.userId);
  if (existing && existing.status === "ACTIVE" && existing.expiresAt > Date.now()) return res.status(200).json(existing);
  const event = eventById(input.eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  const ticket = event.tickets.find(t => t.id === input.ticketTypeId);
  if (!ticket) return res.status(404).json({ error: "Ticket type not found" });
  if (availableFor(ticket) < input.quantity) return res.status(409).json({ error: "Not enough tickets remain. Please choose a smaller quantity." });
  ticket.reserved += input.quantity;
  const hold: Hold = {
    id: `hold_${nanoid(12)}`, userId: input.userId, eventId: event.id,
    ticketTypeId: ticket.id, quantity: input.quantity, unitPrice: ticket.price,
    expiresAt: Date.now() + 5 * 60 * 1000, status: "ACTIVE", idempotencyKey: input.idempotencyKey
  };
  state.holds.push(hold);
  saveState();
  res.status(201).json({ ...hold, eventTitle: event.title, ticketType: ticket.name });
});

app.get("/api/holds/:id", (req, res) => {
  expireHolds();
  const hold = getState().holds.find(h => h.id === req.params.id);
  if (!hold) return res.status(404).json({ error: "Hold not found" });
  res.json(hold);
});

app.delete("/api/holds/:id", (req, res) => {
  expireHolds();
  const hold = getState().holds.find(h => h.id === req.params.id);
  if (!hold) return res.status(404).json({ error: "Hold not found" });
  if (hold.status === "ACTIVE") {
    const ticket = eventById(hold.eventId)?.tickets.find(t => t.id === hold.ticketTypeId);
    if (ticket) ticket.reserved = Math.max(0, ticket.reserved - hold.quantity);
    hold.status = "RELEASED";
    saveState();
  }
  res.json({ ok: true, status: hold.status });
});

const checkoutSchema = z.object({
  holdId: z.string().min(1),
  userId: z.string().min(3),
  outcome: z.enum(["success", "failure"]),
  idempotencyKey: z.string().min(8).max(120)
});

app.post("/api/payments/checkout", (req, res) => {
  expireHolds();
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid checkout request", details: parsed.error.flatten() });
  const input = parsed.data;
  const state = getState();
  const prior = state.bookings.find(b => b.holdId === input.holdId);
  if (prior) return res.json(prior);
  const hold = state.holds.find(h => h.id === input.holdId);
  if (!hold || hold.userId !== input.userId) return res.status(404).json({ error: "Hold not found" });
  if (hold.status !== "ACTIVE" || hold.expiresAt <= Date.now()) return res.status(409).json({ error: "Your ticket hold has expired. Please select tickets again." });
  const event = eventById(hold.eventId);
  const ticket = event?.tickets.find(t => t.id === hold.ticketTypeId);
  if (!event || !ticket) return res.status(404).json({ error: "Event or ticket no longer exists" });

  let booking: Booking;
  if (input.outcome === "success") {
    ticket.reserved = Math.max(0, ticket.reserved - hold.quantity);
    ticket.sold += hold.quantity;
    hold.status = "CONSUMED";
    booking = {
      reference: `EVT-${nanoid(8).toUpperCase()}`, userId: input.userId, eventId: event.id,
      eventTitle: event.title, ticketType: ticket.name, quantity: hold.quantity,
      total: hold.unitPrice * hold.quantity, status: "CONFIRMED", paymentStatus: "SUCCEEDED",
      createdAt: new Date().toISOString(), holdId: hold.id
    };
  } else {
    ticket.reserved = Math.max(0, ticket.reserved - hold.quantity);
    hold.status = "RELEASED";
    booking = {
      reference: `EVT-${nanoid(8).toUpperCase()}`, userId: input.userId, eventId: event.id,
      eventTitle: event.title, ticketType: ticket.name, quantity: hold.quantity,
      total: hold.unitPrice * hold.quantity, status: "PAYMENT_FAILED", paymentStatus: "FAILED",
      createdAt: new Date().toISOString(), holdId: hold.id
    };
  }
  state.bookings.push(booking);
  saveState();
  res.status(201).json(booking);
});

app.get("/api/bookings", (req, res) => {
  const userId = String(req.query.userId || "");
  if (!userId) return res.status(400).json({ error: "userId is required" });
  const items = getState().bookings.filter(b => b.userId === userId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ items });
});

app.get("/api/bookings/:reference", (req, res) => {
  const booking = getState().bookings.find(b => b.reference === req.params.reference);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  res.json(booking);
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("API error:", err instanceof Error ? err.message : "Unknown error");
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => console.log(`Eventora API listening on http://localhost:${PORT}`));
}

export default app;
