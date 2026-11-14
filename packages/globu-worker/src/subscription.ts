import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const UsageWindowSchema = z.object({ window: z.string(), utilization: z.number(), resetsAt: z.string() });
const SubscriptionSchema = z.object({ seenAt: z.string(), windows: z.array(UsageWindowSchema) });

export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SUBSCRIPTION_FILE = "subscription.json";

function fileOf(home: string): string {
  return path.join(home, SUBSCRIPTION_FILE);
}

export function loadSubscription(home: string): Subscription | null {
  const file = fileOf(home);
  if (!fs.existsSync(file)) return null;
  const parsed = SubscriptionSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}

export function recordUsage(home: string, windows: UsageWindow[], now: Date): void {
  const kept = (loadSubscription(home)?.windows ?? []).filter(
    (old) => !windows.some((fresh) => fresh.window === old.window)
  );
  const subscription: Subscription = { seenAt: now.toISOString(), windows: [...kept, ...windows] };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(fileOf(home), `${JSON.stringify(subscription, null, 2)}\n`);
}

export function onSubscription(env: NodeJS.ProcessEnv): boolean {
  return !env.ANTHROPIC_API_KEY;
}

export function currentUsage(home: string, env: NodeJS.ProcessEnv, now: Date): UsageWindow[] {
  if (!onSubscription(env)) return [];
  return (loadSubscription(home)?.windows ?? []).filter((entry) => new Date(entry.resetsAt) > now);
}

export function percent(utilization: number): number {
  return Math.round(utilization * 100);
}

export function overLimit(windows: UsageWindow[], limit: number): UsageWindow | null {
  const over = windows.filter((entry) => percent(entry.utilization) >= limit);
  if (over.length === 0) return null;
  return over.reduce((latest, entry) => (entry.resetsAt > latest.resetsAt ? entry : latest));
}

export function windowName(window: string): string {
  return window.replaceAll("_", "-");
}

export function resetTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function holdReason(entry: UsageWindow, limit: number): string {
  return `the subscription's ${windowName(entry.window)} window is at ${percent(entry.utilization)} %, the limit is ${limit} %, it resets at ${resetTime(entry.resetsAt)}`;
}

export function usageLine(windows: UsageWindow[], limit: number): string {
  if (windows.length === 0) return "";
  const held = overLimit(windows, limit);
  if (held !== null)
    return `subscription ${windowName(held.window)} at ${percent(held.utilization)} %, holding until ${resetTime(held.resetsAt)}`;
  const figures = windows.map((entry) => `${windowName(entry.window)} ${percent(entry.utilization)} %`).join(", ");
  return `subscription ${figures} of ${limit} %`;
}
