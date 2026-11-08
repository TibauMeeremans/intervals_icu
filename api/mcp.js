// Intervals.icu remote MCP server (stateless Streamable HTTP, JSON responses)
// Env: INTERVALS_API_KEY (required), MCP_TOKEN (required, secret in URL), INTERVALS_ATHLETE_ID (optional, default "0" = key owner)
import { timingSafeEqual } from "node:crypto";

const BASE = "https://intervals.icu/api/v1";
const SERVER_INFO = { name: "intervals-icu", version: "1.0.0" };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const athlete = () => process.env.INTERVALS_ATHLETE_ID || "0";

async function icu(method, path, { query, body } = {}) {
  const key = process.env.INTERVALS_API_KEY;
  if (!key) throw new Error("INTERVALS_API_KEY env var is not set on the server.");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from("API_KEY:" + key).toString("base64"),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Intervals.icu ${method} ${url.pathname} -> ${res.status}: ${text.slice(0, 500)}`);
  if (!text) return { ok: true, status: res.status };
  try { return JSON.parse(text); } catch { return text; }
}

const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(d);
   const today = () => fmt(new Date());
   const daysAgo = (n) => fmt(new Date(Date.now() - n * 86400e3));

const ACT_FIELDS = [
  "id", "start_date_local", "type", "name", "distance", "moving_time", "elapsed_time",
  "total_elevation_gain", "average_speed", "pace", "gap", "average_heartrate", "max_heartrate",
  "average_cadence", "icu_average_watts", "icu_weighted_avg_watts", "icu_training_load", "trimp",
  "icu_intensity", "icu_efficiency_factor", "decoupling", "icu_ctl", "icu_atl", "calories",
  "perceived_exertion", "icu_rpe", "feel", "device_name", "source", "description",
];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o[k]]));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const DATE = { type: "string", description: "YYYY-MM-DD" };
const RO = { readOnlyHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: "get_athlete",
    description: "Get the athlete profile: name, sport settings (FTP, threshold pace, LTHR, HR/pace/power zones), weight, timezone.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Get athlete profile", ...RO },
    run: () => icu("GET", `/athlete/${athlete()}`),
  },
  {
    name: "list_activities",
    description: "List completed activities between two dates (default last 14 days). Returns compact fields (distance m, time s, pace m/s, load, HR, CTL/ATL). Set full=true for every field.",
    inputSchema: {
      type: "object",
      properties: {
        oldest: DATE, newest: DATE,
        type: { type: "string", description: "Optional filter, e.g. Run, Ride, Swim, WeightTraining" },
        limit: { type: "integer", description: "Max activities to return (default 50)" },
        full: { type: "boolean" },
      },
    },
    annotations: { title: "List activities", ...RO },
    run: async ({ oldest, newest, type, limit = 50, full = false }) => {
      let list = await icu("GET", `/athlete/${athlete()}/activities`, { query: { oldest: oldest || daysAgo(14), newest: newest || today() } });
      if (!Array.isArray(list)) return list;
      if (type) list = list.filter((a) => (a.type || "").toLowerCase() === type.toLowerCase());
      list = list.slice(0, limit);
      return full ? list : list.map((a) => pick(a, ACT_FIELDS));
    },
  },
  {
    name: "get_activity",
    description: "Get one activity in full detail, optionally with its intervals/laps (intervals=true).",
    inputSchema: {
      type: "object",
      properties: { activity_id: { type: "string", description: "e.g. i12345678" }, intervals: { type: "boolean" } },
      required: ["activity_id"],
    },
    annotations: { title: "Get activity", ...RO },
    run: ({ activity_id, intervals }) => icu("GET", `/activity/${encodeURIComponent(activity_id)}`, { query: { intervals: intervals ? "true" : undefined } }),
  },
  {
    name: "get_activity_streams",
    description: "Get time-series streams for an activity (e.g. time, heartrate, velocity_smooth, cadence, altitude, distance, watts). Large: request only the types you need. Set downsample to keep every Nth point.",
    inputSchema: {
      type: "object",
      properties: {
        activity_id: { type: "string" },
        types: { type: "string", description: "Comma-separated, e.g. time,heartrate,velocity_smooth" },
        downsample: { type: "integer", description: "Keep every Nth sample (default 10)" },
      },
      required: ["activity_id"],
    },
    annotations: { title: "Get activity streams", ...RO },
    run: async ({ activity_id, types = "time,heartrate,velocity_smooth,cadence,distance", downsample = 10 }) => {
      const s = await icu("GET", `/activity/${encodeURIComponent(activity_id)}/streams.json`, { query: { types } });
      const n = Math.max(1, downsample);
      return Array.isArray(s) ? s.map((st) => ({ ...st, data: Array.isArray(st.data) ? st.data.filter((_, i) => i % n === 0) : st.data, data2: undefined })) : s;
    },
  },
  {
    name: "get_wellness",
    description: "Get daily wellness + fitness between two dates (default last 14 days): CTL (fitness), ATL (fatigue), form = CTL-ATL, rampRate, restingHR, HRV, sleep, weight, readiness, soreness, mood, etc.",
    inputSchema: { type: "object", properties: { oldest: DATE, newest: DATE } },
    annotations: { title: "Get wellness & fitness", ...RO },
    run: async ({ oldest, newest }) => {
      const rows = await icu("GET", `/athlete/${athlete()}/wellness`, { query: { oldest: oldest || daysAgo(14), newest: newest || today() } });
      return Array.isArray(rows)
        ? rows.map((r) => ({ ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)), form: r.ctl != null && r.atl != null ? +(r.ctl - r.atl).toFixed(1) : undefined }))
        : rows;
    },
  },
  {
    name: "list_events",
    description: "List calendar events (planned workouts, races, notes) between two dates (default today to +14 days).",
    inputSchema: {
      type: "object",
      properties: {
        oldest: DATE, newest: DATE,
        category: { type: "string", description: "Optional comma list: WORKOUT, RACE_A, RACE_B, RACE_C, NOTE, PLAN, HOLIDAY, SICK, INJURED, TARGET" },
      },
    },
    annotations: { title: "List calendar events", ...RO },
    run: ({ oldest, newest, category }) => icu("GET", `/athlete/${athlete()}/events`, { query: { oldest: oldest || today(), newest: newest || daysAgo(-14), category } }),
  },
  {
    name: "get_event",
    description: "Get one calendar event including its structured workout.",
    inputSchema: { type: "object", properties: { event_id: { type: "integer" } }, required: ["event_id"] },
    annotations: { title: "Get event", ...RO },
    run: ({ event_id }) => icu("GET", `/athlete/${athlete()}/events/${event_id}`),
  },
  {
    name: "list_workout_library",
    description: "List workouts saved in the Intervals.icu workout library.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List workout library", ...RO },
    run: () => icu("GET", `/athlete/${athlete()}/workouts`),
  },
  {
    name: "create_event",
    description:
      "Create a calendar event. For a planned workout use category WORKOUT and write the steps in Intervals.icu workout text syntax in `description`, e.g. \"Warmup\\n- 10m Z1 Pace\\n\\nMain 5x\\n- 3m Z4 Pace\\n- 2m Z1 Pace\\n\\nCooldown\\n- 10m Z1 Pace\". Syncs to the watch if the athlete has calendar sync on.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...DATE, description: "Local date YYYY-MM-DD" },
        category: { type: "string", description: "WORKOUT (default), RACE_A, RACE_B, RACE_C, NOTE, HOLIDAY, SICK, INJURED" },
        type: { type: "string", description: "Sport: Run, Ride, Swim, WeightTraining, Walk, etc." },
        name: { type: "string" },
        description: { type: "string", description: "Workout text / notes" },
        moving_time: { type: "integer", description: "Planned duration in seconds (optional)" },
        distance: { type: "number", description: "Planned distance in meters (optional)" },
        load_target: { type: "integer", description: "Planned training load (optional)" },
        extra: { type: "object", description: "Any other raw event fields to send" },
      },
      required: ["date", "name"],
    },
    annotations: { title: "Create calendar event", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: ({ date, category = "WORKOUT", type, name, description, moving_time, distance, load_target, extra }) =>
      icu("POST", `/athlete/${athlete()}/events`, {
        body: clean({ start_date_local: `${date}T00:00:00`, category, type, name, description, moving_time, distance, load_target, ...(extra || {}) }),
      }),
  },
  {
    name: "update_event",
    description: "Update fields of an existing calendar event (only send what changes). Use `date` to move it.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "integer" },
        date: DATE,
        name: { type: "string" },
        description: { type: "string" },
        type: { type: "string" },
        category: { type: "string" },
        moving_time: { type: "integer" },
        distance: { type: "number" },
        load_target: { type: "integer" },
        extra: { type: "object" },
      },
      required: ["event_id"],
    },
    annotations: { title: "Update calendar event", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: ({ event_id, date, extra, ...rest }) =>
      icu("PUT", `/athlete/${athlete()}/events/${event_id}`, {
        body: clean({ ...rest, start_date_local: date ? `${date}T00:00:00` : undefined, ...(extra || {}) }),
      }),
  },
  {
    name: "delete_event",
    description: "Delete a calendar event (planned workout, note, race). Cannot be undone.",
    inputSchema: { type: "object", properties: { event_id: { type: "integer" } }, required: ["event_id"] },
    annotations: { title: "Delete calendar event", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: ({ event_id }) => icu("DELETE", `/athlete/${athlete()}/events/${event_id}`),
  },
  {
    name: "update_wellness",
    description: "Set wellness values for a day (e.g. weight, restingHR, hrv, sleepSecs, soreness 1-4, fatigue 1-4, stress 1-4, mood 1-4, motivation 1-4, comments).",
    inputSchema: {
      type: "object",
      properties: { date: DATE, fields: { type: "object", description: "Wellness fields to set" } },
      required: ["date", "fields"],
    },
    annotations: { title: "Update wellness", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: ({ date, fields }) => icu("PUT", `/athlete/${athlete()}/wellness/${date}`, { body: { id: date, ...fields } }),
  },
  {
    name: "update_activity",
    description: "Update a completed activity's editable fields, e.g. name, description, type, perceived_exertion, feel.",
    inputSchema: {
      type: "object",
      properties: { activity_id: { type: "string" }, fields: { type: "object" } },
      required: ["activity_id", "fields"],
    },
    annotations: { title: "Update activity", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: ({ activity_id, fields }) => icu("PUT", `/activity/${encodeURIComponent(activity_id)}`, { body: fields }),
  },
  {
    name: "api_get",
    description:
      "Escape hatch: GET any Intervals.icu API v1 path (read-only). Use {athlete} for the athlete id. Examples: /athlete/{athlete}/pace-curves.json?type=Run&curves=90d, /athlete/{athlete}/hr-curves.json?type=Run, /athlete/{athlete}/power-curves.json?type=Ride, /athlete/{athlete}/activities.csv, /activity/{id}/intervals, /athlete/{athlete}/gear.json. Docs: https://intervals.icu/api-docs.html",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path after /api/v1, may include query string" } },
      required: ["path"],
    },
    annotations: { title: "Raw API GET", ...RO },
    run: async ({ path }) => {
      if (!path.startsWith("/") || path.includes("..")) throw new Error("path must start with / and not contain ..");
      const [p, qs] = path.replace(/\{athlete\}/g, athlete()).split("?");
      return icu("GET", p, { query: Object.fromEntries(new URLSearchParams(qs || "")) });
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const MAX_CHARS = 200_000;

async function handle(msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return err(-32600, "Invalid Request");
  if (id === undefined) return null; // notification

  switch (method) {
    case "initialize": {
      const v = params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED.includes(v) ? v : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Intervals.icu training data for the athlete. Units: distance meters, time seconds, speed/pace m/s. Dates are local (Europe/Brussels). Form (TSB) = CTL - ATL. Prefer list_* tools with date ranges; use api_get for anything else.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOL_MAP[params?.name];
      if (!tool) return err(-32602, `Unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params.arguments || {});
        let text = typeof out === "string" ? out : JSON.stringify(out);
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + `\n...[truncated ${text.length - MAX_CHARS} chars, narrow the date range or fields]`;
        return ok({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

function tokenOk(given) {
  const want = process.env.MCP_TOKEN;
  if (!want || want.length < 16 || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!tokenOk(req.query?.token)) return res.status(404).json({ error: "not found" });

  if (req.method === "GET") return res.status(405).setHeader("Allow", "POST").end();
  if (req.method === "DELETE") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handle(body);
  return out ? res.status(200).json(out) : res.status(202).end();
}
