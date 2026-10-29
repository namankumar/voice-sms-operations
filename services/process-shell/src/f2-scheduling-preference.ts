export type SchedulingPreference = Readonly<{
  weekday?: string;
  alternativeWeekdays?: readonly string[];
  daypart?: "morning" | "afternoon" | "evening";
  sourceId: string;
}>;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Caller wording is a ranking hint, never an availability fact or booking authority. */
export function schedulingPreference(inputs: readonly Readonly<{ id: string; body: string; questionKind?: string | undefined }>[]): SchedulingPreference | null {
  let selected: SchedulingPreference | null = null;
  for (const input of inputs) {
    if (input.questionKind && !["patient_status", "request_clarification", "slot_selection"].includes(input.questionKind)) continue;
    const body = input.body.toLowerCase();
    const mentionedDays = [...body.matchAll(/\b(sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/g)];
    const positiveDays = mentionedDays.filter((match) => !/\b(?:not|no)\s*$/.test(body.slice(Math.max(0, match.index! - 8), match.index)));
    const day = positiveDays.at(-1) ?? null;
    if (day === null && mentionedDays.length > 0 && selected?.weekday !== undefined
      && mentionedDays.some((match) => selected?.weekday?.toLowerCase().startsWith(match[1]!.slice(0, 3)))) {
      selected = null;
      continue;
    }
    const part = body.match(/\b(mornings?|afternoons?|evenings?)\b/);
    const cue = /\b(prefer|preferably|best|works?|available|free|only|can do|could do|rather|instead|actually|looking for|need|want)\b/;
    const requestCue = /\b(?:schedule|reschedule|move|book|appointment)\b/.test(body);
    if ((!cue.test(body) && !requestCue && input.questionKind !== "slot_selection") || (day === null && part === null)) continue;
    const weekdays = [...new Set(positiveDays.map((match) => WEEKDAYS.find((value) => value.toLowerCase().startsWith(match[1]!.slice(0, 3)))))]
      .filter((value): value is string => value !== undefined);
    const weekday = weekdays[0];
    const daypart = part === null ? undefined : part[1]!.startsWith("morn") ? "morning" as const
      : part[1]!.startsWith("after") ? "afternoon" as const : "evening" as const;
    selected = { ...(weekday === undefined ? {} : { weekday }), ...(weekdays.length <= 1 ? {} : { alternativeWeekdays: weekdays.slice(1) }),
      ...(daypart === undefined ? {} : { daypart }), sourceId: input.id };
  }
  return selected;
}

export function preferenceMatch(startsAt: string, timeZone: string, preference: SchedulingPreference): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(startsAt));
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const daypart = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const preferredDays = [preference.weekday, ...(preference.alternativeWeekdays ?? [])];
  return (preference.weekday === undefined ? 0 : Number(preferredDays.includes(weekday)) * 2)
    + (preference.daypart === undefined ? 0 : Number(preference.daypart === daypart));
}
